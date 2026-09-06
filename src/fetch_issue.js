const { outputPath, archivePath } = require('./output_layout');
﻿const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { removeInjectedAiSummaryInstructions } = require('./content_cleanup');
const { detectIssueCoverImageUrl, saveIssueCoverImage } = require('./issue_cover');

function loadConfig() {
  const configPath = path.resolve(process.env.CAIXIN_CONFIG || './config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}. Copy config.example.json to config.json first.`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileName(name) {
  return String(name || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeSlug(name) {
  return sanitizeFileName(name).replace(/ /g, '_');
}

function normalizeText(input) {
  return String(input || '').replace(/\s+/g, '').toLowerCase();
}

function sortLinksBySectionOrder(links, config) {
  const order = Array.isArray(config.sectionDownloadOrder) ? config.sectionDownloadOrder : [];
  if (!order.length) {
    return links;
  }

  const orderMap = new Map(order.map((section, index) => [normalizeText(section), index]));

  return links
    .map((item, index) => ({ ...item, __index: index }))
    .sort((left, right) => {
      const leftRank = orderMap.has(normalizeText(left.section))
        ? orderMap.get(normalizeText(left.section))
        : Number.MAX_SAFE_INTEGER;
      const rightRank = orderMap.has(normalizeText(right.section))
        ? orderMap.get(normalizeText(right.section))
        : Number.MAX_SAFE_INTEGER;

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      return left.__index - right.__index;
    })
    .map(({ __index, ...rest }) => rest);
}
function detectIssueLabel(pageText, config) {
  const normalized = String(pageText || '').replace(/\s+/g, '');
  const prefix = config.bookTitlePrefix || '财新周刊';

  const strongMatch = normalized.match(/(?:本文来源于)?《?财新周刊》?(\d{4})年(?:第)?(\d{1,2})期/);
  if (strongMatch) {
    const year = strongMatch[1];
    const issue = String(strongMatch[2]).padStart(2, '0');
    return `${prefix}-${year}年${issue}期`;
  }

  const fallbackMatch = normalized.match(/(\d{4})年(?:第)?(\d{1,2})期/);
  if (fallbackMatch) {
    const year = fallbackMatch[1];
    const issue = String(fallbackMatch[2]).padStart(2, '0');
    return `${prefix}-${year}年${issue}期`;
  }

  return '';
}
function pickFirst($, selectorList) {
  const selectors = String(selectorList || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const selector of selectors) {
    const candidate = $(selector).first();
    if (candidate.length) {
      return candidate;
    }
  }
  return null;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let stableRounds = 0;
      let totalRounds = 0;
      let previousHeight = -1;

      const timer = setInterval(() => {
        totalRounds += 1;
        window.scrollBy(0, 1000);
        const nextHeight = document.body.scrollHeight;
        if (nextHeight === previousHeight) {
          stableRounds += 1;
        } else {
          stableRounds = 0;
        }

        previousHeight = nextHeight;
        if (stableRounds >= 3 || totalRounds >= 12) {
          clearInterval(timer);
          resolve();
        }
      }, 350);
    });
  });
}

async function findFirstButton(page, selectors) {
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.count()) {
      return button;
    }
  }
  return null;
}

async function hasReadMoreButton(page) {
  const buttonSelectors = [
    'text=余下全文',
    'text=展开全文',
    'text=阅读全文',
    'a:has-text("余下全文")',
    'button:has-text("余下全文")',
    'a:has-text("展开全文")',
    'button:has-text("展开全文")'
  ];

  const button = await findFirstButton(page, buttonSelectors);
  return Boolean(button);
}

async function revealFullText(page) {
  const buttonSelectors = [
    'text=余下全文',
    'text=展开全文',
    'text=阅读全文',
    'a:has-text("余下全文")',
    'button:has-text("余下全文")',
    'a:has-text("展开全文")',
    'button:has-text("展开全文")'
  ];

  let clickedCount = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let button = await findFirstButton(page, buttonSelectors);

    if (!button) {
      await autoScroll(page);
      await page.waitForTimeout(700);
      button = await findFirstButton(page, buttonSelectors);
    }

    if (!button) {
      break;
    }

    try {
      const href = await button.getAttribute('href');
      if (href && /(?:\?p\d*|#page\d+)/i.test(href)) {
        const targetUrl = new URL(href, page.url()).toString();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        clickedCount += 1;
        break;
      }

      await button.click({ timeout: 3000 });
      clickedCount += 1;
    } catch {
      break;
    }

    await page.waitForTimeout(2000);
    await autoScroll(page);
    await page.waitForTimeout(900);
  }

  return clickedCount;
}

function normalizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function isAllowedArticleUrl(url, config) {
  try {
    const parsed = new URL(url);
    return (config.articleAllowDomains || []).some((domain) => parsed.hostname.includes(domain));
  } catch {
    return false;
  }
}

function looksLikeArticlePage(url, config) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || '/';
    if (pathname === '/' || pathname === '') {
      return false;
    }

    const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
    if (!lastSegment) {
      return false;
    }

    const customPatterns = Array.isArray(config.articleUrlPatterns) ? config.articleUrlPatterns : [];
    if (customPatterns.length) {
      return customPatterns.some((pattern) => {
        try {
          return new RegExp(pattern).test(url);
        } catch {
          return false;
        }
      });
    }

    const hasDateInPath = /\d{4}-\d{2}-\d{2}/.test(pathname);
    const hasLongNumericId = /\d{6,}/.test(pathname);
    const hasHtmlSuffix = /\.html?$/i.test(lastSegment);
    return hasDateInPath || hasLongNumericId || hasHtmlSuffix;
  } catch {
    return false;
  }
}

function hasBlockedTitle(title, config) {
  const blocked = Array.isArray(config.skipTitleKeywords) ? config.skipTitleKeywords : [
    '上一期', '下一期', '往期回顾', '周刊导播', '融媒精选', '订阅', '广告'
  ];

  return blocked.some((keyword) => String(title || '').includes(keyword));
}

async function gotoWithRetry(page, url, config) {
  const retries = Number(process.env.CAIXIN_NAVIGATION_RETRIES || config.navigationRetries || 4);
  const timeoutMs = Number(process.env.CAIXIN_NAVIGATION_TIMEOUT_MS || config.navigationTimeoutMs || 90000);
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(30000, timeoutMs) }).catch(() => {});
      await page.waitForTimeout(1200);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        console.warn(`Navigation retry ${attempt}/${retries} for ${url}`);
        await page.waitForTimeout(1500 * attempt);
      }
    }
  }

  throw lastError;
}

async function collectIssueLinks(page, issueUrl, config) {
  await gotoWithRetry(page, issueUrl, config);
  await autoScroll(page);
  await page.waitForTimeout(1000);
  const pageText = await page.evaluate(() => document.body ? document.body.innerText : '');
  const detectedIssueTitle = detectIssueLabel(pageText, config);
  const detectedCoverImageUrl = detectIssueCoverImageUrl(
    await page.content(),
    issueUrl,
    config.selectors && config.selectors.issueCover
  );

  const targetSections = Array.isArray(config.targetSections) ? config.targetSections : [];

  const anchors = await page.evaluate((sections) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
    const pickSection = (text) => {
      const normalized = normalize(text);
      for (const section of sections) {
        const key = normalize(section);
        if (!key) {
          continue;
        }
        if (normalized === key || normalized.startsWith(key) || normalized.includes(key)) {
          return section;
        }
      }
      return '';
    };

    const result = [];
    let currentSection = '';

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();

    while (node) {
      const tag = (node.tagName || '').toLowerCase();
      const text = (node.textContent || '').trim();

      if (tag !== 'a' && text && text.length <= 36) {
        const matchedSection = pickSection(text);
        if (matchedSection) {
          currentSection = matchedSection;
        }
      }

      if (tag === 'a' && currentSection) {
        const href = node.href || node.getAttribute('href') || '';
        const linkText = (node.textContent || '').trim();
        if (href && linkText) {
          result.push({ href, text: linkText, section: currentSection });
        }
      }

      node = walker.nextNode();
    }

    return result;
  }, targetSections);

  const dedup = new Map();

  for (const item of anchors) {
    const normalizedHref = normalizeUrl(item.href, issueUrl);
    if (!normalizedHref) {
      continue;
    }

    const includeHit = (config.issueLinkInclude || []).some((word) => normalizedHref.includes(word));
    const textHit = targetSections.length ? Boolean(item.section) : true;
    const blocked = hasBlockedTitle(item.text, config);

    if (!includeHit || !textHit || blocked) {
      continue;
    }

    if (!isAllowedArticleUrl(normalizedHref, config) || !looksLikeArticlePage(normalizedHref, config)) {
      continue;
    }

    if (!dedup.has(normalizedHref)) {
      dedup.set(normalizedHref, {
        href: normalizedHref,
        text: item.text,
        section: item.section || ''
      });
    }
  }

  const orderedLinks = sortLinksBySectionOrder(Array.from(dedup.values()), config);

  return {
    links: orderedLinks.slice(0, Number(config.articleLimit || 30)),
    detectedIssueTitle,
    detectedCoverImageUrl
  };
}

function pruneIrrelevantBlocks($, contentEl, includeCoverContext) {
  const noisySelectors = [
    '.related',
    '.recommend',
    '.recommendation',
    '.more',
    '.hotnews',
    '.en-report',
    '.english',
    '[class*=\"related\"]',
    '[class*=\"recommend\"]',
    '[class*=\"english\"]',
    '[id*=\"related\"]',
    '[id*=\"recommend\"]'
  ];

  for (const selector of noisySelectors) {
    contentEl.find(selector).remove();
  }

  const noiseKeywords = ['相关报道', '英文报道', '推荐阅读', '延伸阅读', '更多阅读'];
  contentEl.find('h1,h2,h3,h4,h5,strong,b,dt').each((_, node) => {
    const text = String($(node).text() || '').replace(/\s+/g, '');
    if (!text || text.length > 12) {
      return;
    }

    const isNoiseHeading = noiseKeywords.some((keyword) => text.includes(keyword));
    if (!isNoiseHeading) {
      return;
    }

    const heading = $(node);
    heading.nextAll().remove();
    heading.remove();
  });

  // Remove link-only blocks (table of links, related links, guide lists).
  contentEl.find('section,div,ul,ol,aside').each((_, node) => {
    const block = $(node);
    const linkCount = block.find('a').length;
    if (linkCount < 3) {
      return;
    }

    const blockText = String(block.text() || '').replace(/\s+/g, '');
    const linkText = String(block.find('a').text() || '').replace(/\s+/g, '');
    const nonLinkLength = Math.max(blockText.length - linkText.length, 0);
    const hasNoiseKeyword = noiseKeywords.some((keyword) => blockText.includes(keyword));

    if (hasNoiseKeyword || nonLinkLength < 80) {
      block.remove();
    }
  });

  // Remove obvious navigation links inside article body.
  contentEl.find('a').each((_, node) => {
    const text = String($(node).text() || '').replace(/\s+/g, '');
    if (!text) {
      return;
    }

    if (text.includes('上一期') || text.includes('下一期') || text.includes('往期回顾')) {
      $(node).closest('li,p,div,section').remove();
    }
  });

  const coverSelectors = [
    '.cover',
    '.cover-story',
    '[class*=\"cover\"]',
    '[id*=\"cover\"]'
  ];

  if (!includeCoverContext) {
    for (const selector of coverSelectors) {
      contentEl.find(selector).remove();
    }

    // Remove issue-intro blocks that contain cover image + guide links.
    contentEl.find('section,div,article,p').each((_, node) => {
      const block = $(node);
      const text = String(block.text() || '').replace(/\s+/g, '');
      const hasIssueTag = /财新周刊\d{4}年第\d{1,2}期/.test(text) || /《财新周刊》\d{4}年第\d{1,2}期/.test(text);
      if (!hasIssueTag) {
        return;
      }

      const links = block.find('a').length;
      const images = block.find('img').length;
      if (text.length < 500 && (links > 0 || images > 0 || text.length < 140)) {
        block.remove();
      }
    });

    // Remove cover-like images in non-first article.
    contentEl.find('img').each((_, node) => {
      const image = $(node);
      const src = String(image.attr('src') || '').toLowerCase();
      const alt = String(image.attr('alt') || '').toLowerCase();
      const title = String(image.attr('title') || '').toLowerCase();
      const token = `${src} ${alt} ${title}`;

      const looksLikeCover = token.includes('cover')
        || token.includes('fengmian')
        || token.includes('caixinweekly')
        || token.includes('week')
        || token.includes('周刊')
        || token.includes('封面');

      if (looksLikeCover) {
        const block = image.closest('figure,p').first();
        if (block.length && String(block.text() || '').replace(/\s+/g, '').length < 500) {
          block.remove();
        } else {
          image.remove();
        }
      }
    });

    contentEl.find('h1,h2,h3,h4,strong,b').each((_, node) => {
      const text = String($(node).text() || '').replace(/\s+/g, '');
      if (text.includes('封面报道') || text.includes('CoverStory')) {
        const block = $(node).closest('p,li,figure,section,div,article').first();
        if (block.length && String(block.text() || '').replace(/\s+/g, '').length < 500) {
          block.remove();
        }
      }
    });
  }
}
function cleanupDom(contentEl, removeSelectors) {
  for (const selector of removeSelectors || []) {
    contentEl.find(selector).remove();
  }

  contentEl.find('*').each((_, element) => {
    const attribs = element.attribs || {};
    for (const name of Object.keys(attribs)) {
      if (name.startsWith('on') || name === 'style' || name === 'srcset') {
        delete attribs[name];
      }
    }
  });
}

function extractBodyTextLength(contentEl) {
  return String(contentEl.text() || '').replace(/\s+/g, '').length;
}

function parseArticleSnapshot(html, config, articleUrl, includeCoverContext, fallbackTitle) {
  const $ = cheerio.load(html);
  const titleEl = pickFirst($, config.selectors.articleTitle);
  const authorEl = pickFirst($, config.selectors.articleAuthor);
  const dateEl = pickFirst($, config.selectors.articleDate);
  const contentEl = pickFirst($, config.selectors.articleContent);

  if (!contentEl || !contentEl.length) {
    return null;
  }

  cleanupDom(contentEl, config.removeSelectors || []);
  removeInjectedAiSummaryInstructions($, contentEl);
  pruneIrrelevantBlocks($, contentEl, includeCoverContext);

  contentEl.find('img').each((_, image) => {
    const attribs = image.attribs || {};
    const src = attribs.src || attribs['data-src'] || attribs['data-original'];
    const normalized = src ? normalizeUrl(src, articleUrl) : null;
    if (normalized) {
      attribs.src = normalized;
    } else {
      delete attribs.src;
    }
    delete attribs['data-src'];
    delete attribs['data-original'];
  });

  const pageTitle = $('title').first().text().trim()
    .replace(/\s*[_-]财新(?:周刊频道)?_?财新网\s*$/i, '')
    .trim();
  const titleCandidates = [
    titleEl ? titleEl.text().trim() : '',
    String(fallbackTitle || '').trim(),
    String($('meta[property="og:title"]').attr('content') || '').trim(),
    String($('meta[name="twitter:title"]').attr('content') || '').trim(),
    pageTitle
  ];
  const resolvedTitle = titleCandidates.find((candidate) => candidate && candidate.toLowerCase() !== 'untitled') || 'untitled';

  return {
    title: resolvedTitle,
    author: authorEl ? authorEl.text().trim() : '',
    pubDate: dateEl ? dateEl.text().trim() : '',
    contentHtml: contentEl.html() || '',
    bodyTextLength: extractBodyTextLength(contentEl),
    contentImageCount: contentEl.find('img[src]').length
  };
}

async function waitForBestSnapshot(page, config, articleUrl, includeCoverContext, fallbackTitle) {
  const targetLength = Number(config.minBodyTextLength || 800);
  const minAcceptLength = Number(config.minAcceptBodyTextLength || 280);
  const passes = Number(config.articleLoadPasses || 8);
  const passDelayMs = Number(config.articlePassDelayMs || 2000);

  let bestSnapshot = null;
  let bestLength = 0;
  let bestImageCount = 0;
  let stableRounds = 0;
  let totalClicks = 0;

  for (let pass = 1; pass <= passes; pass += 1) {
    await autoScroll(page);
    await page.waitForTimeout(700);
    totalClicks += await revealFullText(page);
    await page.waitForTimeout(passDelayMs);

    const html = await page.content();
    const snapshot = parseArticleSnapshot(html, config, articleUrl, includeCoverContext, fallbackTitle);
    if (!snapshot) {
      continue;
    }

    const snapshotImageCount = Number(snapshot.contentImageCount || 0);
    const hasContent = snapshot.bodyTextLength > 0 || snapshotImageCount > 0;
    const isBetter = snapshot.bodyTextLength > bestLength
      || (snapshot.bodyTextLength === bestLength && snapshotImageCount > bestImageCount);

    if (hasContent && (!bestSnapshot || isBetter)) {
      bestLength = snapshot.bodyTextLength;
      bestImageCount = snapshotImageCount;
      bestSnapshot = snapshot;
      stableRounds = 0;
    } else {
      stableRounds += 1;
    }

    const readMoreVisible = await hasReadMoreButton(page);

    if (bestLength >= targetLength && !readMoreVisible) {
      return { snapshot: bestSnapshot, totalClicks };
    }

    if (bestLength >= targetLength && stableRounds >= 1) {
      return { snapshot: bestSnapshot, totalClicks };
    }

    if (!readMoreVisible && stableRounds >= 2 && bestLength >= minAcceptLength) {
      return { snapshot: bestSnapshot, totalClicks };
    }

    if (!readMoreVisible && stableRounds >= 1 && bestImageCount > 0) {
      return { snapshot: bestSnapshot, totalClicks };
    }
  }

  if (bestSnapshot) {
    return { snapshot: bestSnapshot, totalClicks };
  }

  throw new Error(`Could not find article body for ${articleUrl}`);
}

async function extractArticle(page, articleUrl, config, includeCoverContext, fallbackTitle) {
  await gotoWithRetry(page, articleUrl, config);

  const { snapshot, totalClicks } = await waitForBestSnapshot(
    page,
    config,
    articleUrl,
    includeCoverContext,
    fallbackTitle
  );

  return {
    url: articleUrl,
    title: snapshot.title,
    author: snapshot.author,
    pubDate: snapshot.pubDate,
    contentHtml: snapshot.contentHtml,
    bodyTextLength: snapshot.bodyTextLength,
    revealClickedTimes: totalClicks
  };
}

function buildArticleHtml(article) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${article.title}</title>
  <style>
    body { font-family: "Microsoft YaHei", sans-serif; max-width: 48em; margin: 0 auto; padding: 1.5em; line-height: 1.8; }
    h1 { font-size: 1.8em; margin-bottom: 0.5em; }
    .meta { color: #666; margin-bottom: 1.5em; font-size: 0.95em; }
    img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
    p { margin: 0.9em 0; }
  </style>
</head>
<body>
  <h1>${article.title}</h1>
  <div class="meta">${[article.author, article.pubDate].filter(Boolean).join(' | ')}</div>
  <div class="content">${article.contentHtml}</div>
</body>
</html>`;
}

async function launchBrowserContext(config) {
  const browserArgs = [];
  if (config.noProxy) {
    browserArgs.push('--no-proxy-server');
  } else if (config.proxyServer) {
    browserArgs.push(`--proxy-server=${config.proxyServer}`);
  }

  const userDataDir = path.resolve(config.profileDir);
  const preferred = config.browserChannel || 'chrome';
  const fallbackChannels = Array.isArray(config.browserFallbackChannels)
    ? config.browserFallbackChannels
    : ['msedge', 'chromium'];
  const channels = Array.from(new Set([preferred, ...fallbackChannels]));

  const launchBase = {
    headless: Boolean(config.headless),
    viewport: { width: 1440, height: 960 }
  };

  const errors = [];

  for (const channelName of channels) {
    for (const safeGpuMode of [false, true]) {
      const attemptArgs = safeGpuMode
        ? Array.from(new Set([...browserArgs, '--disable-gpu', '--disable-software-rasterizer']))
        : browserArgs;

      const launchOptions = {
        ...launchBase,
        args: attemptArgs
      };

      if (channelName !== 'chromium') {
        launchOptions.channel = channelName;
      }

      const modeLabel = safeGpuMode ? 'safe-gpu' : 'normal';
      try {
        if (safeGpuMode) {
          console.warn(`Browser launch retry with ${channelName} (${modeLabel})`);
        }
        return await chromium.launchPersistentContext(userDataDir, launchOptions);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        errors.push(`${channelName}/${modeLabel}: ${message.split('\n')[0]}`);
      }
    }
  }

  throw new Error(`Failed to launch persistent browser context. Attempts: ${errors.join(' | ')}`);
}

async function main() {
  const config = loadConfig();
  const cliArgs = process.argv.slice(2);
  const resumeExisting = cliArgs.includes('--resume');
  const issueUrl = cliArgs.find((arg) => !arg.startsWith('--')) || config.issueUrl;
  if (!issueUrl) {
    throw new Error('Missing issue URL. Pass it as the first argument or set config.issueUrl.');
  }

  ensureDir(path.resolve(config.profileDir));
  ensureDir(path.resolve(config.archiveDir || './archive'));
  ensureDir(path.resolve(config.outputDir));

  let context = await launchBrowserContext(config);
  const existingPages = context.pages();
  const page = existingPages.length ? existingPages[0] : await context.newPage();

  console.log(`Opening issue page: ${issueUrl}`);
  const { links, detectedIssueTitle, detectedCoverImageUrl } = await collectIssueLinks(page, issueUrl, config);
  console.log('Candidate article links: ' + links.length);

  if (!links.length) {
    throw new Error('No candidate article links found. Check targetSections/articleUrlPatterns for the issue page.');
  }

  const issueTitle = detectedIssueTitle || `${config.bookTitlePrefix}-${new Date().toISOString().slice(0, 10)}`;
  if (detectedIssueTitle) {
    console.log(`Detected issue label: ${detectedIssueTitle}`);
  } else {
    console.warn('Issue label not found on page, fallback to date-based title.');
  }
  if (detectedCoverImageUrl) {
    console.log(`Detected issue cover: ${detectedCoverImageUrl}`);
    const coverOutputDir = path.resolve(
      outputPath(config, { title: issueTitle, source: 'caixin' }, 'dir')
    );
    try {
      const coverPath = await saveIssueCoverImage(
        context.request,
        detectedCoverImageUrl,
        '封面',
        coverOutputDir,
        config.imageDownloadTimeoutMs
      );
      console.log(`Saved issue cover: ${coverPath}`);
    } catch (error) {
      console.warn(`Issue cover save failed: ${error.message || error}`);
    }
  } else {
    console.warn('Issue cover image not found on page.');
  }
  const issueDir = archivePath(config, { title: issueTitle, source: 'caixin' });
  ensureDir(issueDir);

  const manifestPath = path.join(issueDir, 'manifest.json');
  let existingItemsByUrl = new Map();
  if (resumeExisting && fs.existsSync(manifestPath)) {
    try {
      const existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      existingItemsByUrl = new Map(
        (Array.isArray(existingManifest.items) ? existingManifest.items : [])
          .filter((item) => item && item.url && item.file)
          .map((item) => [item.url, item])
      );
      console.log(`Resume mode: ${existingItemsByUrl.size} existing articles available.`);
    } catch (error) {
      console.warn(`Could not read existing manifest, starting normally: ${error.message}`);
    }
  }

  const manifest = {
    title: issueTitle,
    source: 'caixin',
    publisher: '财新周刊',
    sourceIssueUrl: issueUrl,
    coverImageUrl: detectedCoverImageUrl,
    createdAt: new Date().toISOString(),
    items: []
  };

  const itemsByIndex = new Array(links.length).fill(null);
  let failedIndexes = [];

  function saveArticle(index, link, article) {
    const fileName = `${String(index + 1).padStart(2, '0')}_${safeSlug(article.title)}.html`;
    const outputPath = path.join(issueDir, fileName);
    fs.writeFileSync(outputPath, buildArticleHtml(article), 'utf-8');
    itemsByIndex[index] = {
      title: article.title,
      author: article.author,
      pubDate: article.pubDate,
      section: link.section || '',
      url: article.url,
      bodyTextLength: article.bodyTextLength,
      fullTextClicks: article.revealClickedTimes,
      file: fileName
    };
  }

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const prefix = link.section ? `[${link.section}] ` : '';
    console.log(`[${index + 1}/${links.length}] ${prefix}${link.text || link.href}`);

    const existingItem = existingItemsByUrl.get(link.href);
    if (existingItem && fs.existsSync(path.join(issueDir, existingItem.file))) {
      itemsByIndex[index] = {
        ...existingItem,
        section: link.section || existingItem.section || ''
      };
      console.log(`  -> reused ${existingItem.file}`);
      continue;
    }

    if (resumeExisting) {
      failedIndexes.push(index);
      console.log('  -> queued for isolated retry');
      continue;
    }

    try {
      const article = await extractArticle(page, link.href, config, index === 0, link.text);
      console.log(`  -> bodyTextLength=${article.bodyTextLength}, fullTextClicks=${article.revealClickedTimes}`);
      saveArticle(index, link, article);
    } catch (error) {
      failedIndexes.push(index);
      console.warn(`Initial attempt failed ${link.href}`);
      console.warn(error.message);
    }
  }

  const retryPasses = Math.max(0, Number(config.articleRetryPasses ?? 1));
  for (let pass = 1; pass <= retryPasses && failedIndexes.length; pass += 1) {
    console.warn(`Retry pass ${pass}/${retryPasses}: ${failedIndexes.length} article(s).`);
    const remainingIndexes = [];
    for (const index of failedIndexes) {
      const link = links[index];
      const prefix = link.section ? `[${link.section}] ` : '';
      console.log(`[retry ${pass}] [${index + 1}/${links.length}] ${prefix}${link.text || link.href}`);
      await context.close().catch(() => {});
      context = await launchBrowserContext(config);
      const retryPages = context.pages();
      const retryPage = retryPages.length ? retryPages[0] : await context.newPage();
      try {
        const article = await extractArticle(retryPage, link.href, config, index === 0, link.text);
        console.log(`  -> bodyTextLength=${article.bodyTextLength}, fullTextClicks=${article.revealClickedTimes}`);
        saveArticle(index, link, article);
      } catch (error) {
        remainingIndexes.push(index);
        console.warn(`Retry failed ${link.href}`);
        console.warn(error.message);
      }
    }
    failedIndexes = remainingIndexes;
  }

  for (const index of failedIndexes) {
    console.warn(`Skip after retries ${links[index].href}`);
  }

  manifest.items = itemsByIndex.filter(Boolean);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`Saved issue files to ${issueDir}`);
  await context.close();
  if (failedIndexes.length) throw new Error(`Incomplete issue: ${failedIndexes.length} articles failed; resume before building.`);
  if (process.env.ARCHIVE_RESULT_FILE) fs.writeFileSync(process.env.ARCHIVE_RESULT_FILE, JSON.stringify({ issueDir }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  buildArticleHtml,
  hasBlockedTitle,
  parseArticleSnapshot
};











