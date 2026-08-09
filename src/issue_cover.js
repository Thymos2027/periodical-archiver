const cheerio = require('cheerio');

const DEFAULT_COVER_SELECTORS = '.cover img, img[alt*="财新周刊"], [class*="cover"] img';

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

module.exports = {
  detectIssueCoverImageUrl,
  resolveIssueCoverImageUrl
};
