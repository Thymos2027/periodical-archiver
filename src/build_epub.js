const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cheerio = require('cheerio');
const { removeInjectedAiSummaryInstructions } = require('./content_cleanup');
const { resolveIssueCoverImageUrl } = require('./issue_cover');

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
      return {
        fullPath,
        mtimeMs: fs.statSync(fullPath).mtimeMs
      };
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

function escapeXml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeZipPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function normalizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function inferExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname || '').toLowerCase();
    if (ext && /^\.[a-z0-9]{1,5}$/i.test(ext)) {
      return ext;
    }
  } catch {
    // Ignore invalid URLs.
  }
  return '';
}

function extFromMimeType(contentType) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/avif': '.avif'
  };
  return map[type] || '';
}

function mimeTypeFromExt(ext) {
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif'
  };
  return map[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function buildIndexHtml(manifest) {
  const items = manifest.items.map((item, index) => {
    const meta = [item.author, item.pubDate].filter(Boolean).join(' | ');
    return `<li><a href="articles/article-${String(index + 1).padStart(3, '0')}.xhtml">${escapeHtml(item.title)}</a>${meta ? ` <span>${escapeHtml(meta)}</span>` : ''}</li>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8" />
  <title>${escapeHtml(manifest.title)}</title>
  <style type="text/css">
    body { font-family: "Microsoft YaHei", sans-serif; max-width: 48em; margin: 0 auto; padding: 1.5em; line-height: 1.8; }
    h1 { margin-bottom: 0.3em; }
    .desc { color: #666; margin-bottom: 1.5em; }
    li { margin: 0.6em 0; }
    span { color: #666; }
  </style>
</head>
<body>
  <h1>${escapeHtml(manifest.title)}</h1>
  <div class="desc">Source: ${escapeHtml(manifest.sourceIssueUrl || '')}</div>
  <h2>目录</h2>
  <ol>
    ${items}
  </ol>
</body>
</html>`;
}

function buildCoverHtml(title, coverImage) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8" />
  <title>${escapeHtml(title)}</title>
  <style type="text/css">
    html, body { height: 100%; margin: 0; padding: 0; text-align: center; }
    img { height: 100%; max-height: 100%; max-width: 100%; object-fit: contain; }
  </style>
</head>
<body>
  <img src="${escapeHtml(coverImage.href)}" alt="${escapeHtml(title)}" />
</body>
</html>`;
}

function buildContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function buildTocNcx(metadata, items) {
  const navPoints = items.map((item, index) => {
    return `    <navPoint id="navPoint-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${escapeXml(item.title)}</text></navLabel>
      <content src="${escapeXml(item.href)}"/>
    </navPoint>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(metadata.uid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(metadata.title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`;
}

function buildContentOpf(metadata, items, images, coverImage) {
  const articleManifest = items.map((item, index) => {
    return `    <item id="a${index + 1}" href="${escapeXml(item.href)}" media-type="application/xhtml+xml"/>`;
  }).join('\n');

  const imageManifest = images.map((img, index) => {
    return `    <item id="img${index + 1}" href="${escapeXml(img.href)}" media-type="${escapeXml(img.mediaType)}"/>`;
  }).join('\n');

  const articleSpine = items.map((_, index) => {
    return `    <itemref idref="a${index + 1}"/>`;
  }).join('\n');

  const coverMetadata = coverImage ? '\n    <meta name="cover" content="cover-image"/>' : '';
  const coverManifest = coverImage
    ? `\n    <item id="cover-page" href="cover.html" media-type="application/xhtml+xml"/>\n    <item id="cover-image" href="${escapeXml(coverImage.href)}" media-type="${escapeXml(coverImage.mediaType)}"/>`
    : '';
  const coverSpine = coverImage ? '\n    <itemref idref="cover-page" linear="yes"/>' : '';
  const coverGuide = coverImage
    ? '\n  <guide>\n    <reference type="cover" title="Cover" href="cover.html"/>\n  </guide>'
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(metadata.uid)}</dc:identifier>
    <dc:title>${escapeXml(metadata.title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:creator>${escapeXml(metadata.author || '财新周刊')}</dc:creator>
    <dc:date>${escapeXml(metadata.date)}</dc:date>${coverMetadata}
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="index" href="index.html" media-type="application/xhtml+xml"/>${coverManifest}
${articleManifest}
${imageManifest}
  </manifest>
  <spine toc="ncx">${coverSpine}
    <itemref idref="index"/>
${articleSpine}
  </spine>${coverGuide}
</package>`;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    crc = CRC32_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = Math.floor(date.getSeconds() / 2);

  const dosTime = (hour << 11) | (minute << 5) | second;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;

  return { dosDate, dosTime };
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(normalizeZipPath(entry.name), 'utf8');
    const flags = /[^\x00-\x7F]/.test(entry.name) ? 0x0800 : 0;
    const input = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.store ? 0 : 8;
    const compressed = method === 0 ? input : zlib.deflateRawSync(input);
    const crc = crc32(input);
    const { dosDate, dosTime } = dosDateTime(entry.date);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034B50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(input.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014B50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(input.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; caixin-archive/1.0)'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      data: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || ''
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeArticleXhtml($, baseUrl) {
  const unwrapTags = ['cximg', 'cxread', 'cxcode', 'paywall'];
  for (const tag of unwrapTags) {
    $(tag).toArray().reverse().forEach((node) => {
      $(node).replaceWith($(node).contents());
    });
  }

  $('anchor, link, script, noscript, iframe').remove();
  $('html, html *').contents().filter((_, node) => node.type === 'comment').remove();

  const allowedTags = new Set([
    'html', 'head', 'title', 'meta', 'style', 'body',
    'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'a', 'img', 'br', 'hr', 'b', 'strong', 'i', 'em', 'small',
    'sub', 'sup', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'
  ]);

  $('body *').toArray().reverse().forEach((node) => {
    if (!allowedTags.has(String(node.tagName || '').toLowerCase())) {
      $(node).replaceWith($(node).contents());
    }
  });

  const globalAttributes = new Set(['id', 'class', 'title', 'lang', 'xml:lang', 'dir']);
  const tagAttributes = {
    a: new Set(['href', 'name', 'rel']),
    img: new Set(['src', 'alt', 'width', 'height']),
    meta: new Set(['http-equiv', 'content', 'name']),
    style: new Set(['type']),
    td: new Set(['colspan', 'rowspan', 'headers']),
    th: new Set(['colspan', 'rowspan', 'headers', 'scope'])
  };

  $('*').each((_, node) => {
    const element = $(node);
    const tagName = String(node.tagName || '').toLowerCase();
    const allowed = tagAttributes[tagName] || new Set();
    for (const name of Object.keys(node.attribs || {})) {
      if (!globalAttributes.has(name) && !allowed.has(name)) {
        element.removeAttr(name);
      }
    }
  });

  $('a').each((_, node) => {
    const link = $(node);
    const href = String(link.attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^mailto:/i.test(href)) {
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      return;
    }
    if (/^(?:\/|\.\/|\.\.\/|\/\/)/.test(href)) {
      const absolute = normalizeUrl(href, baseUrl);
      if (absolute && /^https?:\/\//i.test(absolute)) {
        link.attr('href', absolute);
        return;
      }
    }
    link.removeAttr('href');
  });
  $('img').each((_, node) => {
    const img = $(node);
    if (!img.attr('alt')) {
      img.attr('alt', '');
    }
  });

  $('html')
    .attr('xmlns', 'http://www.w3.org/1999/xhtml')
    .attr('xml:lang', 'zh-CN')
    .removeAttr('lang');
  $('head meta').remove();
  $('head').prepend('<meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/>');
  $('style').attr('type', 'text/css');

  const serialized = $.xml().replace(/^<!DOCTYPE html>/i, '');
  return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n${serialized}`;
}

async function embedImagesIntoHtml(htmlText, baseUrl, imageState, articleTitle) {
  const $ = cheerio.load(htmlText, { decodeEntities: true });
  removeInjectedAiSummaryInstructions($, $('body'));
  if (articleTitle) {
    $('title').first().text(articleTitle);
    $('body > h1').first().text(articleTitle);
  }
  const imageNodes = $('img').toArray();

  for (const node of imageNodes) {
    const img = $(node);
    const rawSrc = (img.attr('src') || '').trim();
    if (!rawSrc || /^data:/i.test(rawSrc)) {
      continue;
    }

    const absolute = normalizeUrl(rawSrc, baseUrl) || rawSrc;
    if (!/^https?:\/\//i.test(absolute)) {
      continue;
    }
    if (/favicon\.ico(?:$|\?)/i.test(absolute)) {
      img.remove();
      continue;
    }

    if (imageState.byUrl.has(absolute)) {
      img.attr('src', `../${imageState.byUrl.get(absolute).href}`);
      continue;
    }

    try {
      const downloaded = await fetchWithTimeout(absolute, imageState.timeoutMs);
      if (!downloaded.data.length) {
        continue;
      }

      const ext = extFromMimeType(downloaded.contentType) || inferExtFromUrl(absolute) || '.jpg';
      const fileName = `img_${String(imageState.items.length + 1).padStart(4, '0')}${ext}`;
      const href = `images/${fileName}`;
      const mediaType = mimeTypeFromExt(ext);

      const imageItem = { href, data: downloaded.data, mediaType };
      imageState.byUrl.set(absolute, imageItem);
      imageState.items.push(imageItem);
      img.attr('src', `../${href}`);
    } catch (error) {
      console.warn(`Image download failed: ${absolute} (${error.message || error})`);
    }
  }

  return normalizeArticleXhtml($, baseUrl);
}

async function buildEpub(issueDir, manifest, outputFile, config) {
  const imageState = {
    byUrl: new Map(),
    items: [],
    timeoutMs: Number(config.imageDownloadTimeoutMs || 20000)
  };

  let coverImage = null;
  try {
    const coverUrl = await resolveIssueCoverImageUrl(manifest, config);
    if (coverUrl) {
      const downloaded = await fetchWithTimeout(coverUrl, imageState.timeoutMs);
      const ext = extFromMimeType(downloaded.contentType) || inferExtFromUrl(coverUrl) || '.jpg';
      coverImage = {
        href: `images/cover${ext}`,
        data: downloaded.data,
        mediaType: mimeTypeFromExt(ext)
      };
      imageState.byUrl.set(coverUrl, coverImage);
      console.log(`Embedded issue cover: ${coverUrl}`);
    } else {
      console.warn('Issue cover image not found; EPUB will start with the table of contents.');
    }
  } catch (error) {
    console.warn(`Issue cover download failed: ${error.message || error}`);
  }

  const articleItems = [];

  for (let index = 0; index < manifest.items.length; index += 1) {
    const item = manifest.items[index];
    const sourcePath = path.join(issueDir, item.file);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Article HTML not found: ${sourcePath}`);
    }

    const htmlText = fs.readFileSync(sourcePath, 'utf-8');
    const htmlWithLocalImages = await embedImagesIntoHtml(
      htmlText,
      item.url || manifest.sourceIssueUrl || '',
      imageState,
      item.title
    );

    articleItems.push({
      title: item.title || `Article ${index + 1}`,
      href: `articles/article-${String(index + 1).padStart(3, '0')}.xhtml`,
      data: Buffer.from(htmlWithLocalImages, 'utf-8')
    });
  }

  const indexHtml = buildIndexHtml(manifest);
  const metadata = {
    uid: `caixin-${Date.now()}`,
    title: manifest.title || 'Caixin Weekly',
    author: '财新周刊',
    date: new Date().toISOString()
  };

  const entries = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: buildContainerXml() },
    { name: 'OEBPS/content.opf', data: buildContentOpf(metadata, articleItems, imageState.items, coverImage) },
    { name: 'OEBPS/toc.ncx', data: buildTocNcx(metadata, articleItems) },
    { name: 'OEBPS/index.html', data: indexHtml },
    ...(coverImage ? [
      { name: 'OEBPS/cover.html', data: buildCoverHtml(metadata.title, coverImage) },
      { name: `OEBPS/${coverImage.href}`, data: coverImage.data }
    ] : []),
    ...articleItems.map((item) => ({ name: `OEBPS/${item.href}`, data: item.data })),
    ...imageState.items.map((img) => ({ name: `OEBPS/${img.href}`, data: img.data }))
  ];

  fs.writeFileSync(outputFile, makeZip(entries));
  console.log(`Embedded images: ${imageState.items.length}`);
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

  const baseOutputDir = path.resolve(config.outputDir || './output');
  const outputDir = path.resolve(config.epubOutputDir || path.join(baseOutputDir, 'epub'));
  ensureDir(outputDir);
  const outputFile = path.join(outputDir, `${manifest.title}.epub`);
  await buildEpub(issueDir, manifest, outputFile, config);

  console.log(`Built EPUB: ${outputFile}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});


