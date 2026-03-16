const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

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
      let previousHeight = -1;

      const timer = setInterval(() => {
        window.scrollBy(0, 1000);
        const nextHeight = document.body.scrollHeight;
        if (nextHeight === previousHeight) {
          stableRounds += 1;
        } else {
          stableRounds = 0;
        }

        previousHeight = nextHeight;
        if (stableRounds >= 3) {
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
    '上一期', '下一期', '往期回顾', '周刊导播', '订阅', '广告'
  ];

  return blocked.some((keyword) => String(title || '').includes(keyword));
}

async function gotoWithRetry(page, url, config) {
  const retries = Number(config.navigationRetries || 4);
  const timeoutMs = Number(config.navigationTimeoutMs || 90000);
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
    detectedIssueTitle
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
      if (links > 0 || images > 0 || text.length < 140) {
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
        image.closest('figure,p,div,section').remove();
      }
    });

    contentEl.find('h1,h2,h3,h4,strong,b').each((_, node) => {
      const text = String($(node).text() || '').replace(/\s+/g, '');
      if (text.includes('封面报道') || text.includes('CoverStory')) {
        $(node).closest('section,div,article').remove();
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

function parseArticleSnapshot(html, config, articleUrl, includeCoverContext) {
  const $ = cheerio.load(html);
  const titleEl = pickFirst($, config.selectors.articleTitle);
  const authorEl = pickFirst($, config.selectors.articleAuthor);
  const dateEl = pickFirst($, config.selectors.articleDate);
  const contentEl = pickFirst($, config.selectors.articleContent);

  if (!contentEl || !contentEl.length) {
    return null;
  }

  cleanupDom(contentEl, config.removeSelectors || []);
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

  return {
    title: titleEl ? titleEl.text().trim() : 'untitled',
    author: authorEl ? authorEl.text().trim() : '',
    pubDate: dateEl ? dateEl.text().trim() : '',
    contentHtml: contentEl.html() || '',
    bodyTextLength: extractBodyTextLength(contentEl)
  };
}

async function waitForBestSnapshot(page, config, articleUrl, includeCoverContext) {
  const targetLength = Number(config.minBodyTextLength || 800);
  const minAcceptLength = Number(config.minAcceptBodyTextLength || 280);
  const passes = Number(config.articleLoadPasses || 8);
  const passDelayMs = Number(config.articlePassDelayMs || 2000);

  let bestSnapshot = null;
  let bestLength = 0;
  let stableRounds = 0;
  let totalClicks = 0;

  for (let pass = 1; pass <= passes; pass += 1) {
    await autoScroll(page);
    await page.waitForTimeout(700);
    totalClicks += await revealFullText(page);
    await page.waitForTimeout(passDelayMs);

    const html = await page.content();
    const snapshot = parseArticleSnapshot(html, config, articleUrl, includeCoverContext);
    if (!snapshot) {
      continue;
    }

    if (snapshot.bodyTextLength > bestLength) {
      bestLength = snapshot.bodyTextLength;
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
  }

  if (bestSnapshot) {
    return { snapshot: bestSnapshot, totalClicks };
  }

  throw new Error(`Could not find article body for ${articleUrl}`);
}

async function extractArticle(page, articleUrl, config, includeCoverContext) {
  await gotoWithRetry(page, articleUrl, config);

  const { snapshot, totalClicks } = await waitForBestSnapshot(page, config, articleUrl, includeCoverContext);

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
  const issueUrl = process.argv[2] || config.issueUrl;
  if (!issueUrl) {
    throw new Error('Missing issue URL. Pass it as the first argument or set config.issueUrl.');
  }

  ensureDir(path.resolve(config.profileDir));
  ensureDir(path.resolve(config.tempDir));
  ensureDir(path.resolve(config.outputDir));

  const context = await launchBrowserContext(config);
  const existingPages = context.pages();
  const page = existingPages.length ? existingPages[0] : await context.newPage();

  console.log(`Opening issue page: ${issueUrl}`);
  const { links, detectedIssueTitle } = await collectIssueLinks(page, issueUrl, config);
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
  const issueDir = path.join(path.resolve(config.tempDir), safeSlug(issueTitle));
  ensureDir(issueDir);

  const manifest = {
    title: issueTitle,
    sourceIssueUrl: issueUrl,
    createdAt: new Date().toISOString(),
    items: []
  };

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const prefix = link.section ? `[${link.section}] ` : '';
    console.log(`[${index + 1}/${links.length}] ${prefix}${link.text || link.href}`);

    try {
      const article = await extractArticle(page, link.href, config, index === 0);
      console.log(`  -> bodyTextLength=${article.bodyTextLength}, fullTextClicks=${article.revealClickedTimes}`);

      const fileName = `${String(index + 1).padStart(2, '0')}_${safeSlug(article.title)}.html`;
      const outputPath = path.join(issueDir, fileName);
      fs.writeFileSync(outputPath, buildArticleHtml(article), 'utf-8');
      manifest.items.push({
        title: article.title,
        author: article.author,
        pubDate: article.pubDate,
        section: link.section || '',
        url: article.url,
        bodyTextLength: article.bodyTextLength,
        fullTextClicks: article.revealClickedTimes,
        file: fileName
      });
    } catch (error) {
      console.warn(`Skip ${link.href}`);
      console.warn(error.message);
    }
  }

  const manifestPath = path.join(issueDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`Saved issue files to ${issueDir}`);
  await context.close();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});











