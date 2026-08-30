const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const DEFAULT_COVER_SELECTORS = '.cover img, img[alt*="财新周刊"], [class*="cover"] img';

function sanitizeFileName(name) {
  return String(name || '财新周刊封面')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function coverExtension(contentType, imageUrl) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  const byMimeType = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/avif': '.avif'
  };
  if (byMimeType[type]) {
    return byMimeType[type];
  }

  try {
    const extension = path.extname(new URL(imageUrl).pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.avif'].includes(extension)) {
      return extension;
    }
  } catch {
    // Fall through to the common Caixin cover format.
  }

  return '.jpg';
}

function normalizeUrl(href, baseUrl) {
  if (!href) {
    return null;
  }
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function detectIssueCoverImageUrl(html, baseUrl, selectorList) {
  const $ = cheerio.load(String(html || ''));
  const selectors = String(selectorList || DEFAULT_COVER_SELECTORS)
    .split(',')
    .map((selector) => selector.trim())
    .filter(Boolean);

  for (const selector of selectors) {
    const images = $(selector).toArray();
    for (const node of images) {
      const img = $(node);
      const rawSrc = img.attr('src') || img.attr('data-src') || img.attr('data-original') || '';
      const absolute = normalizeUrl(rawSrc, baseUrl);
      if (!absolute || /(?:logo|favicon|icon)(?:[_.-]|\/)/i.test(absolute)) {
        continue;
      }
      return absolute;
    }
  }

  return '';
}

async function resolveIssueCoverImageUrl(manifest, config) {
  const stored = normalizeUrl(manifest.coverImageUrl, manifest.sourceIssueUrl);
  if (stored) {
    return stored;
  }

  const issueUrl = manifest.sourceIssueUrl;
  if (!issueUrl) {
    return '';
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Number(config.imageDownloadTimeoutMs || 20000)
  );

  try {
    const response = await fetch(issueUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; caixin-archive/1.0)'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    return detectIssueCoverImageUrl(html, issueUrl, config.selectors && config.selectors.issueCover);
  } finally {
    clearTimeout(timer);
  }
}

async function saveIssueCoverImage(requestContext, imageUrl, issueTitle, outputDir, timeoutMs) {
  if (!imageUrl) {
    return '';
  }

  const response = await requestContext.get(imageUrl, {
    failOnStatusCode: false,
    timeout: Number(timeoutMs || 20000)
  });
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()}`);
  }

  const contentType = response.headers()['content-type'] || '';
  const extension = coverExtension(contentType, imageUrl);
  const coverDir = path.resolve(outputDir);
  const outputPath = path.join(coverDir, `${sanitizeFileName(issueTitle)}${extension}`);
  fs.mkdirSync(coverDir, { recursive: true });
  fs.writeFileSync(outputPath, await response.body());
  return outputPath;
}

module.exports = {
  detectIssueCoverImageUrl,
  resolveIssueCoverImageUrl,
  saveIssueCoverImage
};
