# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

A Windows personal archiver for 财新周刊 and 三联生活周刊. Playwright reuses the local Chrome profile; built-in exporters generate EPUB, PDF, TXT, summaries and covers. Calibre is not required.

## Commands

```powershell
corepack enable                 # Enable the package manager shim provided by Node.js
pnpm install                    # Install dependencies
pnpm run fetch -- --publication caixin "<issue_url>" # Fetch articles from a weekly issue URL
pnpm run build:epub -- --publication caixin # Build EPUB from most recent fetch (in archive/)
pnpm run build:epub -- --publication caixin ".\archive\财新\<issue_dir>"  # Build EPUB from specific issue directory
pnpm run archive -- --publication lifeweek "<issue_url>"           # Run fetch + build in sequence
powershell -ExecutionPolicy Bypass -File .\scripts\open_chrome_profile.ps1  # Open Chrome with dedicated profile for login
```

## Architecture

Public commands use `src/cli.js` with explicit `--publication caixin|lifeweek` (also 财新/三联). Archive passes the exact captured issue directory to builders through a per-run result file, never the globally newest directory. `src/fetch_lifeweek.js` handles Lifeweek cards and paginated image galleries.

**Three-stage pipeline:**

1. **`src/fetch_issue.js`** - Uses Playwright to launch Chrome with persistent profile (`./profile`), navigates to issue page, collects article links based on `config.json` filters, extracts article content using CSS selectors, and saves HTML files + `manifest.json` to `archive/<publication>/<YYYY年第NN期>/`

2. **`src/build_epub.js`** - Reads `manifest.json`, generates `index.html` with table of contents, packages EPUB directly; `src/output_layout.js` routes all formats to `output/财新或三联/YYYY年第NN期/`

3. **`src/archive.js`** - Orchestrator that runs fetch then build sequentially

**Key design patterns:**
- Configuration-driven: Article extraction selectors, domain allowlists, and link filters are in `config.json`. Prefer modifying config over code changes.
- Persistent browser profile: Playwright launches Chrome with `--user-data-dir` pointing to `./profile` to reuse login state. The profile must be set up separately via `scripts/open_chrome_profile.ps1`.
- Fallback selectors: `pickFirst()` tries multiple comma-separated CSS selectors and uses the first match.

## Configuration

`config.json` contains:
- `selectors` - CSS selectors for title, author, date, and content extraction
- `issueLinkInclude` / `issueLinkTextAllow` - Filters for identifying article links on issue pages
- `articleAllowDomains` - Domain whitelist for article URLs
- `removeSelectors` - Elements to strip from article content (ads, scripts, etc.)
- `articleLimit` - Max articles per issue
- `headless` - Set to `false` for debugging

## Environment

- Node.js 20+ required
- pnpm 10.14.0 (declared in `package.json`; enable it with Corepack)
- Chrome must be installed
- Output paths come from `outputDir` only; per-format output directory keys are retired. TXT and summary use distinct `.txt` / `.summary.txt` names; covers use `封面.<ext>`. Historical date labels can be mapped through `issueLabels` after verification.
- `CAIXIN_CONFIG` env var can override config file path

原始文章 HTML 与 `manifest.json` 持久保存在 `archive/财新或三联/YYYY年第NN期/`，由 `archiveDir` 配置。重建与断点续抓读取此目录。`tmp/` 仅保存测试、校验及迁移过程文件，任务结束后可清理，不参与正式重建。`archive/` 与账号资料一样不提交 Git；备份时应保留。
