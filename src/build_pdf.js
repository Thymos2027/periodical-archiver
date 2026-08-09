const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

function loadConfig() {
  const configPath = path.resolve(process.env.CAIXIN_CONFIG || './config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}. Copy config.example.json to config.json first.`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function findNewestIssueDir(tempDir) {
  const fullTempDir = path.resolve(tempDir);
  if (!fs.existsSync(fullTempDir)) {
    throw new Error(`Temp directory not found: ${fullTempDir}`);
  }

  const candidates = fs.readdirSync(fullTempDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(fullTempDir, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  if (!candidates.length) {
    throw new Error(`No issue directories found under ${fullTempDir}`);
  }

  return candidates[0].fullPath;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

async function fetchImageAsDataUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        referer: 'https://weekly.caixin.com/',
        'user-agent': 'Mozilla/5.0 (compatible; caixin-archive/1.0)'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      throw new Error(`Unexpected content type: ${contentType || 'unknown'}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length) },
    () => run()
  );
  await Promise.all(workers);
  return results;
}

function readArticles(issueDir, manifest) {
  return manifest.items.map((item, index) => {
    const sourcePath = path.join(issueDir, item.file);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Article HTML not found: ${sourcePath}`);
    }

    const $ = cheerio.load(fs.readFileSync(sourcePath, 'utf-8'), { decodeEntities: false });
    const content = $('.content').first();
    const contentHtml = content.length ? content.html() : $('body').html();

    return {
      ...item,
      index,
      contentHtml: contentHtml || ''
    };
  });
}

async function inlineArticleImages(articles, config) {
  const imageUrls = new Set();

  for (const article of articles) {
    const $ = cheerio.load(`<div id="article-root">${article.contentHtml}</div>`, { decodeEntities: false });
    $('#article-root img').each((_, node) => {
      const img = $(node);
      const rawSrc = String(img.attr('src') || '').trim();
      const absolute = normalizeUrl(rawSrc, article.url || 'https://weekly.caixin.com/');

      if (!absolute || /favicon\.ico(?:$|\?)/i.test(absolute)) {
        img.remove();
        return;
      }

      if (/^https?:\/\//i.test(absolute)) {
        img.attr('src', absolute);
        imageUrls.add(absolute);
      }
    });
    article.contentHtml = $('#article-root').html() || '';
  }

  const urls = Array.from(imageUrls);
  const timeoutMs = Number(config.imageDownloadTimeoutMs || 20000);
  const concurrency = Number(config.imageDownloadConcurrency || 8);
  const imageMap = new Map();

  await mapWithConcurrency(urls, concurrency, async (url) => {
    try {
      imageMap.set(url, await fetchImageAsDataUrl(url, timeoutMs));
    } catch (error) {
      console.warn(`Image download failed: ${url} (${error.message || error})`);
    }
  });

  for (const article of articles) {
    const $ = cheerio.load(`<div id="article-root">${article.contentHtml}</div>`, { decodeEntities: false });
    $('#article-root img').each((_, node) => {
      const img = $(node);
      const replacement = imageMap.get(String(img.attr('src') || ''));
      if (replacement) {
        img.attr('src', replacement);
      }
    });
    article.contentHtml = $('#article-root').html() || '';
  }

  console.log(`Embedded PDF images: ${imageMap.size}/${urls.length}`);
}

function buildPrintHtml(manifest, articles) {
  const toc = articles.map((article) => {
    const meta = [article.section, article.author].filter(Boolean).join(' / ');
    return `<li><a href="#article-${article.index + 1}">${escapeHtml(article.title)}</a>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}</li>`;
  }).join('\n');

  const bodies = articles.map((article) => {
    const meta = [article.section, article.author, article.pubDate].filter(Boolean).join(' / ');
    return `<article class="article" id="article-${article.index + 1}">
      <h1>${escapeHtml(article.title)}</h1>
      ${meta ? `<div class="article-meta">${escapeHtml(meta)}</div>` : ''}
      <div class="article-content">${article.contentHtml}</div>
      <div class="article-source">原文：<a href="${escapeHtml(article.url || '')}">${escapeHtml(article.url || '')}</a></div>
    </article>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(manifest.title)}</title>
  <style>
    * { box-sizing: border-box; }
    html { color: #202124; font-family: "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif; }
    body { margin: 0; font-size: 10.5pt; line-height: 1.75; }
    a { color: inherit; text-decoration: none; }
    .cover { min-height: 245mm; display: flex; flex-direction: column; justify-content: center; text-align: center; break-after: page; }
    .cover-kicker { color: #b31b1b; font-size: 12pt; letter-spacing: 0.24em; margin-bottom: 14mm; }
    .cover h1 { font-family: "Noto Serif CJK SC", "SimSun", serif; font-size: 31pt; line-height: 1.35; margin: 0 auto 10mm; max-width: 160mm; }
    .cover-source { color: #777; font-size: 9pt; overflow-wrap: anywhere; }
    .toc { break-after: page; }
    .toc h1 { border-bottom: 2px solid #b31b1b; font-size: 21pt; padding-bottom: 4mm; }
    .toc ol { padding-left: 7mm; }
    .toc li { margin: 3mm 0; padding-left: 2mm; }
    .toc li span { color: #777; display: block; font-size: 8.5pt; }
    .article { break-before: page; }
    .article h1 { font-family: "Noto Serif CJK SC", "SimSun", serif; font-size: 21pt; line-height: 1.4; margin: 0 0 3mm; }
    .article-meta { color: #777; border-bottom: 1px solid #ddd; font-size: 9pt; margin-bottom: 7mm; padding-bottom: 3mm; }
    .article-content p { margin: 0 0 4mm; text-align: justify; }
    .article-content h2, .article-content h3, .article-content h4 { break-after: avoid; margin: 7mm 0 3mm; }
    .article-content img { break-inside: avoid; display: block; height: auto; margin: 5mm auto; max-height: 220mm; max-width: 100%; object-fit: contain; }
    .article-content figure, .article-content table, .article-content blockquote { break-inside: avoid; max-width: 100%; }
    .article-content table { border-collapse: collapse; width: 100%; }
    .article-content td, .article-content th { border: 1px solid #ccc; padding: 2mm; }
    .article-source { border-top: 1px solid #ddd; color: #888; font-size: 7.5pt; margin-top: 9mm; overflow-wrap: anywhere; padding-top: 3mm; }
    @media print {
      .cover, .toc, .article { orphans: 3; widows: 3; }
    }
  </style>
</head>
<body>
  <section class="cover">
    <div class="cover-kicker">个人离线归档</div>
    <h1>${escapeHtml(manifest.title)}</h1>
    <div class="cover-source">${escapeHtml(manifest.sourceIssueUrl || '')}</div>
  </section>
  <nav class="toc">
    <h1>目录</h1>
    <ol>${toc}</ol>
  </nav>
  ${bodies}
</body>
</html>`;
}

async function launchPrintBrowser(config) {
  const browserArgs = [];
  if (config.noProxy) {
    browserArgs.push('--no-proxy-server');
  } else if (config.proxyServer) {
    browserArgs.push(`--proxy-server=${config.proxyServer}`);
  }

  const preferred = config.browserChannel || 'chrome';
  const fallbackChannels = Array.isArray(config.browserFallbackChannels)
    ? config.browserFallbackChannels
    : ['msedge', 'chromium'];
  const channels = Array.from(new Set([preferred, ...fallbackChannels]));
  const errors = [];

  for (const channelName of channels) {
    const options = { headless: true, args: browserArgs };
    if (channelName !== 'chromium') {
      options.channel = channelName;
    }

    try {
      return await chromium.launch(options);
    } catch (error) {
      errors.push(`${channelName}: ${String(error.message || error).split('\n')[0]}`);
    }
  }

  throw new Error(`Failed to launch a browser for PDF output. Attempts: ${errors.join(' | ')}`);
}

async function buildPdf(issueDir, manifest, outputFile, config) {
  const articles = readArticles(issueDir, manifest);
  await inlineArticleImages(articles, config);
  const printHtml = buildPrintHtml(manifest, articles);

  const browser = await launchPrintBrowser(config);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.setContent(printHtml, { waitUntil: 'load', timeout: Number(config.navigationTimeoutMs || 90000) });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map((image) => {
        if (image.complete) {
          return undefined;
        }
        return new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
      }));
    });

    const pdfConfig = config.pdf || {};
    await page.pdf({
      path: outputFile,
      format: pdfConfig.format || 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="font-size:8px;color:#777;text-align:center;width:100%;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: {
        top: pdfConfig.marginTop || '16mm',
        right: pdfConfig.marginRight || '16mm',
        bottom: pdfConfig.marginBottom || '18mm',
        left: pdfConfig.marginLeft || '16mm'
      },
      tagged: true,
      outline: true
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const config = loadConfig();
  const issueDir = process.argv[2] ? path.resolve(process.argv[2]) : findNewestIssueDir(config.tempDir);
  const manifestPath = path.join(issueDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${issueDir}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(manifest.items) || !manifest.items.length) {
    throw new Error(`No article items found in ${manifestPath}`);
  }

  const outputDir = path.resolve(config.pdfOutputDir || './output/pdf');
  ensureDir(outputDir);
  const outputFile = path.join(outputDir, `${manifest.title}.pdf`);
  await buildPdf(issueDir, manifest, outputFile, config);
  console.log(`Built PDF: ${outputFile}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
