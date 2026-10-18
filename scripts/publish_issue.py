from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import shutil
import socket
import sys
from pathlib import Path

from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.tl.types import DocumentAttributeFilename

from telegram_downloader.config import load_config
from telegram_downloader.zotero import (
    ZoteroApiClient,
    ZoteroJob,
    ZoteroRetryableError,
    parse_magazine_metadata,
    source_id_for_existing_file,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="发布一期已生成的期刊封面、EPUB、PDF 和摘要")
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--epub", type=Path, required=True)
    parser.add_argument("--cover", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--library-dir", type=Path, required=True)
    parser.add_argument("--category", choices=("财新", "三联"), required=True)
    parser.add_argument("--year", required=True)
    parser.add_argument("--credentials-env", type=Path, required=True)
    parser.add_argument("--telegram-config", type=Path, required=True)
    parser.add_argument("--zotero-config", type=Path, required=True)
    parser.add_argument("--telegram-target", required=True)
    parser.add_argument("--skip-zotero", action="store_true")
    parser.add_argument("--skip-telegram", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def copy_to_library(source: Path, library_dir: Path, category: str, year: str) -> Path:
    if not source.is_file():
        raise FileNotFoundError(f"PDF 不存在: {source}")
    destination = library_dir / category / year / source.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_hash = sha256_file(source)
    if destination.exists():
        if sha256_file(destination) != source_hash:
            raise RuntimeError(f"目标存在同名但内容不同的文件，拒绝覆盖: {destination}")
        print(f"Library copy already current: {destination}")
        return destination

    temporary = destination.with_name(f"{destination.name}.part")
    try:
        shutil.copy2(source, temporary)
        if sha256_file(temporary) != source_hash:
            raise RuntimeError(f"复制后的 PDF 哈希不一致: {temporary}")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Copied PDF to library: {destination}")
    return destination


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"凭据文件缺少 {name}")
    return value


async def publish_zotero_once(
    pdf: Path,
    library_dir: Path,
    category: str,
    year: str,
    config_path: Path,
) -> None:
    config = load_config(config_path).zotero
    relative_path = pdf.relative_to(library_dir)
    metadata = parse_magazine_metadata(pdf.name, category, int(year))
    job = ZoteroJob(
        source_id=source_id_for_existing_file(relative_path, None),
        relative_path=relative_path.as_posix(),
        title=metadata.title,
        publication_title=metadata.publication_title,
        category=metadata.category,
        year=metadata.year,
        issue=metadata.issue,
        content_sha256=sha256_file(pdf),
    )
    api = ZoteroApiClient(config, required_env("ZOTERO_USER_ID"), required_env("ZOTERO_API_KEY"))
    try:
        collection_key = await api.ensure_collection_path(category, year)
        parent_key = await api.find_parent(collection_key, job.source_id)
        if not parent_key:
            parent_key = await api.create_parent(job, collection_key)
        linked_path = f"{config.linked_path_prefix}{relative_path.as_posix()}"
        attachment_key = await api.create_attachment(parent_key, linked_path)
        print(f"Published to Zotero: parent={parent_key}, attachment={attachment_key}")
    finally:
        await api.close()


async def publish_zotero(
    pdf: Path,
    library_dir: Path,
    category: str,
    year: str,
    config_path: Path,
) -> None:
    for attempt in range(3):
        try:
            await publish_zotero_once(pdf, library_dir, category, year, config_path)
            return
        except ZoteroRetryableError as error:
            if attempt == 2:
                raise
            delay = max(2 ** attempt, error.retry_after or 0)
            cause = type(error.__cause__).__name__ if error.__cause__ else type(error).__name__
            print(f"Zotero transient failure ({cause}); retrying in {delay:g}s ({attempt + 1}/2)", file=sys.stderr)
            await asyncio.sleep(delay)


def message_filename(message: object) -> str:
    document = getattr(message, "document", None)
    for attribute in getattr(document, "attributes", ()):
        if isinstance(attribute, DocumentAttributeFilename):
            return attribute.file_name
    return ""


async def find_existing_message(client: TelegramClient, target: object, filename: str) -> object | None:
    async for message in client.iter_messages(target, search=filename, limit=100):
        if message_filename(message) == filename:
            return message
    async for message in client.iter_messages(target, limit=200):
        if message_filename(message) == filename:
            return message
    return None


def normalized_caption(value: str) -> str:
    return "".join(str(value or "").split())


async def find_complete_telegram_bundle(
    client: TelegramClient,
    target: object,
    epub_name: str,
    pdf_name: str,
    summary: str,
) -> tuple[object, object] | None:
    epub_message = await find_existing_message(client, target, epub_name)
    pdf_message = await find_existing_message(client, target, pdf_name)
    if not epub_message or not pdf_message:
        return None
    if not epub_message.grouped_id or epub_message.grouped_id != pdf_message.grouped_id:
        return None
    if normalized_caption(pdf_message.message) != normalized_caption(summary):
        return None
    return epub_message, pdf_message


async def publish_telegram(
    cover: Path,
    epub: Path,
    pdf: Path,
    summary_path: Path,
    target: str,
    config: object,
) -> None:
    for artifact in (cover, epub, pdf, summary_path):
        if not artifact.is_file():
            raise FileNotFoundError(f"Telegram 发布文件不存在: {artifact}")
    summary = summary_path.read_text(encoding="utf-8-sig").strip()
    if not summary:
        raise RuntimeError(f"摘要为空: {summary_path}")
    if len(summary) > 1024:
        raise RuntimeError(f"摘要超过 Telegram caption 上限（{len(summary)} > 1024）")
    api_id = int(required_env("TELEGRAM_API_ID"))
    api_hash = required_env("TELEGRAM_API_HASH")
    client = TelegramClient(
        config.session_name,
        api_id,
        api_hash,
        proxy=config.proxy.as_telethon_proxy(),
    )
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise RuntimeError("本机 Telegram 会话尚未登录")
        entity = await client.get_entity(target)
        existing = await find_complete_telegram_bundle(
            client,
            entity,
            epub.name,
            pdf.name,
            summary,
        )
        if existing:
            print(
                f"Telegram bundle already complete: {target}, "
                f"epub={existing[0].id}, pdf={existing[1].id}"
            )
            return
        cover_message = await client.send_file(
            entity,
            cover,
            force_document=False,
        )
        document_messages = await client.send_file(
            entity,
            [epub, pdf],
            caption=["", summary],
            force_document=True,
        )
        if not isinstance(document_messages, list) or len(document_messages) != 2:
            raise RuntimeError("Telegram 未返回完整的 EPUB/PDF 媒体组")
        print(
            f"Uploaded Telegram bundle: {target}, cover={cover_message.id}, "
            f"epub={document_messages[0].id}, pdf={document_messages[1].id}"
        )
    finally:
        await client.disconnect()


def require_telegram_proxy(config: object) -> None:
    if not config.proxy.enabled:
        return
    try:
        with socket.create_connection((config.proxy.host, config.proxy.port), timeout=2):
            return
    except OSError as error:
        raise RuntimeError(
            f"Telegram 代理未监听: {config.proxy.host}:{config.proxy.port}"
        ) from error


async def run(args: argparse.Namespace) -> None:
    source = args.pdf.resolve()
    epub = args.epub.resolve()
    cover = args.cover.resolve()
    summary = args.summary.resolve()
    library_dir = args.library_dir.resolve()
    load_dotenv(args.credentials_env.resolve(), override=False)
    telegram_config = None
    if not args.skip_telegram:
        telegram_config = load_config(args.telegram_config.resolve())
        require_telegram_proxy(telegram_config)
    destination = copy_to_library(source, library_dir, args.category, args.year)
    if not args.skip_zotero:
        await publish_zotero(destination, library_dir, args.category, args.year, args.zotero_config.resolve())
    if not args.skip_telegram:
        await publish_telegram(
            cover,
            epub,
            destination,
            summary,
            args.telegram_target,
            telegram_config,
        )


def main() -> None:
    try:
        asyncio.run(run(parse_args()))
    except Exception as error:
        cause = type(error.__cause__).__name__ if error.__cause__ else type(error).__name__
        print(f"Publish failed ({cause}): {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
