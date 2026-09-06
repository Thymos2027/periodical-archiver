const { outputPath, newestIssueDir } = require('./output_layout');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { removeInjectedAiSummaryInstructions } = require('./content_cleanup');

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

function safeFileName(input) {
  return String(input || 'caixin-weekly')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || 'caixin-weekly';
}

function normalizeText(input) {
  return String(input || '')
    .replace(/\u00A0|\u3000/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function cleanTrainingText(input) {
  return normalizeText(input)
    .replace(/https?:\/\/[A-Za-z0-9./?&_%#=:+~-]+/g, '')
    .replace(/^\s*(?:原文|原文链接|链接)[：:]?\s*$/g, '')
    .trim();
}

function extractArticleText(htmlText) {
  const $ = cheerio.load(htmlText, { decodeEntities: true });
  const content = $('.content').first().length ? $('.content').first() : $('body').first();

  content.find('script,style,noscript,iframe,svg,form,button').remove();
  removeInjectedAiSummaryInstructions($, content);
  content.find('img').remove();

  const blockSelector = 'h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption';
  const paragraphs = [];

  content.find(blockSelector).each((_, node) => {
    const block = $(node);
    if (block.find(blockSelector).length) {
      return;
    }

    const text = cleanTrainingText(block.text()).replace(/\n+/g, ' ');
    if (text && text !== paragraphs[paragraphs.length - 1]) {
      paragraphs.push(text);
    }
  });

  if (!paragraphs.length) {
    const fallback = cleanTrainingText(content.text())
      .split(/\n{2,}/)
      .map((item) => cleanTrainingText(item).replace(/\n+/g, ' '))
      .filter(Boolean);
    paragraphs.push(...fallback);
  }

  return paragraphs.join('\n\n');
}

function resolveArticleTitle(item, htmlText, index) {
  const currentTitle = String(item.title || '').trim();
  if (currentTitle && currentTitle.toLowerCase() !== 'untitled') {
    return currentTitle;
  }

  const $ = cheerio.load(htmlText, { decodeEntities: true });
  const htmlCandidates = [
    $('h1').first().text().trim(),
    $('title').first().text().trim()
  ];
  const htmlTitle = htmlCandidates.find((title) => title && title.toLowerCase() !== 'untitled');
  if (htmlTitle) {
    return htmlTitle;
  }

  const fileTitle = path.basename(String(item.file || ''), path.extname(String(item.file || '')))
    .replace(/^\d+_/, '')
    .trim();
  if (fileTitle && fileTitle.toLowerCase() !== 'untitled') {
    return fileTitle;
  }

  return `第${String(index + 1).padStart(3, '0')}篇`;
}

function buildArticleSection(item, index, articleText) {
  const metadata = [
    `标题：${item.title || `第${index + 1}篇`}`,
    item.section ? `栏目：${item.section}` : '',
    item.author ? `作者：${item.author}` : '',
    item.pubDate ? `日期：${item.pubDate}` : ''
  ].filter(Boolean);

  return [
    `===== 第${String(index + 1).padStart(3, '0')}篇 =====`,
    ...metadata,
    '',
    articleText,
    '',
    `===== 第${String(index + 1).padStart(3, '0')}篇结束 =====`
  ].join('\n');
}

function main() {
  const config = loadConfig();
  const issueDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : newestIssueDir(config);
  const manifestPath = path.join(issueDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (!items.length) {
    throw new Error(`Manifest contains no articles: ${manifestPath}`);
  }

  const sections = [];
  let skippedEmptyArticles = 0;

  items.forEach((item, index) => {
    const sourcePath = path.join(issueDir, item.file || '');
    if (!item.file || !fs.existsSync(sourcePath)) {
      throw new Error(`Article HTML not found: ${sourcePath}`);
    }

    const htmlText = fs.readFileSync(sourcePath, 'utf-8');
    const articleText = extractArticleText(htmlText);
    if (!articleText) {
      skippedEmptyArticles += 1;
      console.warn(`Skip text-empty article: ${sourcePath}`);
      return;
    }

    sections.push(buildArticleSection({
      ...item,
      title: resolveArticleTitle(item, htmlText, index)
    }, index, articleText));
  });

  if (!sections.length) {
    throw new Error(`No extractable article text found: ${manifestPath}`);
  }

  const outputText = [
    manifest.title || '财新周刊',
    `归档文章数：${items.length}`,
    `纯文本文章数：${sections.length}`,
    '',
    ...sections
  ].join('\n\n').replace(/\n{4,}/g, '\n\n\n') + '\n';

  const outputDir = outputPath(config, manifest, 'dir');
  ensureDir(outputDir);
  const outputFile = path.join(outputDir, `${safeFileName(manifest.title)}.txt`);
  fs.writeFileSync(outputFile, outputText, 'utf-8');
  console.log(`Built TXT: ${outputFile}`);
  if (skippedEmptyArticles) {
    console.warn(`Skipped text-empty articles: ${skippedEmptyArticles}`);
  }
}

main();
