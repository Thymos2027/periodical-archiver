"""Import PDFs already in the magazine library into Zotero, without Telegram."""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from telegram_downloader.config import load_config
from telegram_downloader.zotero import (
    ZoteroApiClient,
    source_id_for_existing_file,
)

from publish_issue import publish_zotero


YEAR = re.compile(r"(?:19|20)\d{2}\Z")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="扫描杂志库并将缺失的 PDF 加入 Zotero")
    parser.add_argument("--config", type=Path, required=True, help="本项目 config.json")
    parser.add_argument("--dry-run", action="store_true", help="仅列出缺失文件")
    parser.add_argument("--min-age-seconds", type=int, default=0)
    return parser.parse_args()


def candidates(library: Path, min_age: int) -> list[tuple[Path, str, str]]:
    now = time.time()
    found = []
    for category in ("财新", "三联"):
        category_dir = library / category
        if not category_dir.is_dir():
            continue
        for year_dir in category_dir.iterdir():
            if not year_dir.is_dir() or not YEAR.fullmatch(year_dir.name):
                continue
            for pdf in year_dir.iterdir():
                if pdf.is_file() and pdf.suffix.lower() == ".pdf":
                    stat = pdf.stat()
                    if stat.st_size > 0 and now - stat.st_mtime >= min_age:
                        found.append((pdf, category, year_dir.name))
    return sorted(found, key=lambda row: str(row[0]))


def existing_source_ids(items: list[dict]) -> set[str]:
    ids = set()
    for item in items:
        for line in str(item["data"].get("extra", "")).splitlines():
            if line.startswith("Telegram-Source-ID:"):
                ids.add(line.partition(":")[2].strip())
    return ids


async def collection_items(api: ZoteroApiClient, collection_key: str) -> list[dict]:
    items = []
    start = 0
    while True:
        response = await api._request(
            "GET",
            f"{api.user_prefix}/collections/{collection_key}/items/top",
            params={"limit": 100, "start": start, "itemType": "magazineArticle"},
        )
        page = response.json()
        items.extend(page)
        if len(page) < 100:
            return items
        start += len(page)


async def run(args: argparse.Namespace) -> int:
    import json

    config = json.loads(args.config.resolve().read_text(encoding="utf-8-sig"))
    delivery = config["delivery"]
    library = Path(delivery["libraryDir"]).resolve()
    if not library.is_dir():
        raise RuntimeError(f"杂志库不存在: {library}")
    files = candidates(library, args.min_age_seconds)
    if not files:
        print("没有符合条件的 PDF")
        return 0

    load_dotenv(Path(delivery["credentialsEnv"]), override=False)
    zotero_config = Path(delivery["zoteroConfig"]).resolve()
    api = ZoteroApiClient(
        load_config(zotero_config).zotero,
        os.environ["ZOTERO_USER_ID"],
        os.environ["ZOTERO_API_KEY"],
    )
    missing = []
    try:
        grouped = {}
        for pdf, category, year in files:
            grouped.setdefault((category, year), []).append(pdf)
        for (category, year), group in sorted(grouped.items()):
            # Read-only planning: never create a collection just to inspect it.
            collections = await api._load_collections()
            root_key = api.config.top_collection_key
            if not root_key:
                root = next((c["data"] for c in collections if c["data"]["name"] == api.config.top_collection and not c["data"].get("parentCollection")), None)
                root_key = root["key"] if root else None
            names = dict(api.config.category_collection_names)
            category_collection = next((c["data"] for c in collections if c["data"]["name"] == names.get(category, category) and c["data"].get("parentCollection") == root_key), None)
            year_collection = next((c["data"] for c in collections if c["data"]["name"] == year and category_collection and c["data"].get("parentCollection") == category_collection["key"]), None)
            items = await collection_items(api, year_collection["key"]) if year_collection else []
            source_ids = existing_source_ids(items)
            original_names = {line.partition(":")[2].strip() for item in items for line in str(item["data"].get("extra", "")).splitlines() if line.startswith("Original-File:")}
            for pdf in group:
                relative = pdf.relative_to(library)
                source_id = source_id_for_existing_file(relative, None)
                if source_id in source_ids or pdf.name in original_names:
                    continue
                missing.append((pdf, category, year))
    finally:
        await api.close()

    print(f"扫描 {len(files)} 个 PDF；Zotero 缺失 {len(missing)} 个")
    for pdf, category, year in missing:
        print(f"{'待补录' if args.dry_run else '补录'}: {pdf.relative_to(library)}")
        if not args.dry_run:
            await publish_zotero(pdf, library, category, year, zotero_config)
    return 0


def main() -> None:
    try:
        raise SystemExit(asyncio.run(run(arguments())))
    except Exception as error:
        print(f"Zotero 杂志同步失败 ({type(error).__name__}): {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
