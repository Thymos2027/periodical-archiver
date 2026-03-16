# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

A personal archiving tool for Caixin Weekly (财新周刊) that captures articles from an already logged-in Chrome browser session and builds EPUB files for offline reading. This is a Windows-focused workflow using Playwright for browser automation and Calibre for EPUB generation.

## Commands

```powershell
npm install                    # Install dependencies
npm run fetch -- "<issue_url>" # Fetch articles from a weekly issue URL
npm run build:epub             # Build EPUB from most recent fetch (in tmp/)
npm run build:epub -- ".\tmp\<issue_dir>"  # Build EPUB from specific issue directory
npm run archive -- "<issue_url>"           # Run fetch + build in sequence
powershell -ExecutionPolicy Bypass -File .\scripts\open_chrome_profile.ps1  # Open Chrome with dedicated profile for login
```

## Architecture

**Three-stage pipeline:**

1. **`src/fetch_issue.js`** - Uses Playwright to launch Chrome with persistent profile (`./profile`), navigates to issue page, collects article links based on `config.json` filters, extracts article content using CSS selectors, and saves HTML files + `manifest.json` to `tmp/<issue_title>/`

2. **`src/build_epub.js`** - Reads `manifest.json`, generates `index.html` with table of contents, invokes Calibre's `ebook-convert.exe` to produce EPUB in `output/`

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
- Chrome must be installed
- Calibre required for EPUB generation (`CALIBRE_EBOOK_CONVERT` env var or default install path)
- `CAIXIN_CONFIG` env var can override config file path