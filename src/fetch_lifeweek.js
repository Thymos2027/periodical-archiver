const { outputPath, archivePath } = require('./output_layout');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const { saveIssueCoverImage } = require('./issue_cover');

const escape = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cleanName = (s) => s.replace(/[\\/:*?"<>|]/g, '_').trim();

async function main() {
  const config = JSON.parse(fs.readFileSync(path.resolve(process.env.CAIXIN_CONFIG || 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const issueUrl = process.argv[2];
  if (!/^https:\/\/www\.lifeweek\.com\.cn\/magazine\/\d+$/.test(issueUrl || '')) throw new Error('Provide a Lifeweek magazine URL.');
  const context = await chromium.launchPersistentContext(path.resolve(config.profileDir), {
    channel: config.browserChannel || 'chrome', headless: true,
    args: config.noProxy ? ['--no-proxy-server'] : config.proxyServer ? [`--proxy-server=${config.proxyServer}`] : []
  });
  try {
    const page = await context.newPage();
    const navigate = async () => {
      await page.goto(issueUrl, { waitUntil: 'networkidle', timeout: config.navigationTimeoutMs || 90000 });
      await page.locator('.column-item').first().waitFor();
    };
    await navigate();
    const issue = await page.evaluate(() => {
      const head = document.querySelector('.head-img');
      const detail = window.__NUXT__?.data?.[0]?.magazineDetail?.detail;
      const chapterItems = window.__NUXT__?.data?.[0]?.chapterList?.list
        ?.flatMap(section => (section.list || []).map(item => ({
          id: item.id,
          title: item.title,
          section: section.lanmu
        })))
        .filter(item => item.id && item.title);
      return {
        heading: head.parentElement.parentElement.innerText,
        cover: head.src,
        pubTime: detail?.pubTime,
        issueNumber: detail?.qikan,
        items: chapterItems?.length ? chapterItems : Array.from(document.querySelectorAll('.column .column-item')).map(el => ({
          title: el.querySelector('.name, .img-title')?.textContent.trim(),
          section: el.closest('.column').querySelector('.column-title')?.textContent.trim()
        })).filter(x => x.title)
      };
    });
    const date = String(issue.pubTime || issue.heading).match(/(\d{4})年(\d{2})月(\d{2})日/);
    const number = String(issue.issueNumber || '').match(/\d+/)?.[0]
      || issue.heading.match(/第\s*(\d+)\s*期/)?.[1];
    if (!date || !number || !issue.items.length) throw new Error('Unrecognized issue metadata or empty table of contents.');
    const headingLines = issue.heading.split('\n').map(s => s.trim()).filter(Boolean);
    const subject = headingLines[headingLines.findIndex(s => s.includes('总第')) + 1];
    const title = cleanName(`三联生活周刊 ${date[1]}年第${number}期 ${subject}`);
    const dir = archivePath(config, { title, source: 'lifeweek' });
    fs.mkdirSync(dir, { recursive: true });
    let manifest = { title, source: 'lifeweek', publisher: '三联生活周刊', sourceIssueUrl: issueUrl,
      pubDate: `${date[1]}-${date[2]}-${date[3]}`, coverImageUrl: issue.cover,
      fetchedAt: new Date().toISOString(), expectedArticleCount: issue.items.length, items: [], failures: [] };
    if (process.argv.includes('--resume') && fs.existsSync(path.join(dir, 'manifest.json'))) {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      if (manifest.sourceIssueUrl !== issueUrl) throw new Error('Resume issue URL mismatch.');
      manifest.items = manifest.items.filter(item => fs.existsSync(path.join(dir, item.file)));
      manifest.failures = [];
    }
    const save = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    manifest.coverFile = await saveIssueCoverImage(context.request, issue.cover, '封面', outputPath(config, manifest, 'dir'), config.imageDownloadTimeoutMs);
    console.log(`${title}: ${issue.items.length} entries`);
    for (const [index, item] of issue.items.entries()) {
      if (manifest.items.some(saved => saved.title === item.title)) continue;
      try {
        let popup = null;
        let articlePage = page;
        if (item.id) {
          await page.goto(new URL(`/article/${item.id}`, issueUrl).href, {
            waitUntil: 'networkidle', timeout: config.navigationTimeoutMs || 90000
          });
        } else {
          if (index) await navigate();
          const popupPromise = page.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
          await page.getByText(item.title, { exact: true }).first().click();
          popup = await popupPromise;
          articlePage = popup || page;
        }
        await articlePage.waitForURL(/\/article\/\d+/, { timeout: 15000 });
        await articlePage.locator('.article-body, .imgList-box').first().waitFor({ timeout: 20000 });
        await articlePage.waitForTimeout(1200);
        let article;
        if (await articlePage.locator('.imgList-box').count()) {
          const gallery = articlePage.locator('.imgList-box');
          const count = await gallery.locator('.img-list > .el-carousel__container > .el-carousel__item > .el-image img').count();
          if (!count) throw new Error('Empty image gallery.');
          const frames = [];
          for (let n = 0; n < count; n++) {
            await gallery.locator('.el-pager li').filter({ hasText: new RegExp(`^${n + 1}$`) }).click();
            await articlePage.waitForTimeout(400);
            frames.push(await gallery.evaluate(el => ({
              src: el.querySelector('.img-list > .el-carousel__container > .el-carousel__item.is-active > .el-image img')?.src,
              title: el.querySelector('.pic-title')?.textContent.trim(),
              desc: el.querySelector('.desc')?.textContent.trim()
            })));
          }
          if (frames.some(f => !f.src) || new Set(frames.map(f => f.src)).size !== count) throw new Error('Incomplete gallery pagination.');
          article = { html: frames.map(f => `<h2>${escape(f.title)}</h2><img src="${escape(f.src)}"><p>${escape(f.desc)}</p>`).join(''),
            text: frames.map(f => `${f.title}\n${f.desc}`).join('\n'), author: await articlePage.locator('.imgList-box .author').textContent().catch(() => '三联生活周刊') };
        } else article = await articlePage.evaluate(() => {
          const body = document.querySelector('.article-body');
          return { html: body.innerHTML, text: body.innerText, title: document.querySelector('.header .title')?.textContent.trim(),
            author: document.querySelector('.header .author')?.textContent.replace(/\s+/g, ' ').trim(),
            intro: document.querySelector('.daodu')?.textContent.trim(),
            restricted: /购买后|订阅后|开通会员.*阅读|购买.*解锁/.test(body.parentElement.innerText) };
        });
        const $ = cheerio.load(`<div class="content">${article.html}</div>`);
        if (article.restricted || (!article.text.trim() && !$('.content img').length)) throw new Error('Empty or restricted article; check membership.');
        $('.content script, .content style, .content iframe, .content audio, .content video').remove();
        $('.content *').each((_, el) => {
          for (const attr of Object.keys(el.attribs || {})) if (/^on|^data-v-|^style$/.test(attr)) $(el).removeAttr(attr);
        });
        $('.content img').each((_, el) => {
          const img = $(el); const src = img.attr('data-src') || img.attr('data-original') || img.attr('src');
          if (src) img.attr('src', new URL(src, articlePage.url()).href);
        });
        $('container').each((_, el) => { $(el).replaceWith(`<figure>${$(el).html()}</figure>`); });
        $('center').each((_, el) => { $(el).replaceWith(`<p class="caption">${$(el).html()}</p>`); });
        const file = `${String(index + 1).padStart(3, '0')}_${cleanName(item.title)}.html`;
        const url = articlePage.url();
        const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(item.title)}</title><style>body{font-family:serif;line-height:1.8}img{max-width:100%;height:auto}.caption{color:#666;font-size:.85em}</style></head><body><h1>${escape(item.title)}</h1><p>${escape(article.author)}</p><div class="content">${article.intro ? `<p>${escape(article.intro)}</p>` : ''}${$('.content').html()}</div><p>原文：<a href="${escape(url)}">${escape(url)}</a></p></body></html>`;
        fs.writeFileSync(path.join(dir, file), html);
        manifest.items.push({ ...item, url, file, author: article.author || '', pubDate: manifest.pubDate, contentTextLength: article.text.length, contentImageCount: $('.content img').length });
        console.log(`[${index + 1}/${issue.items.length}] ${item.title}: ${article.text.length} chars, ${$('.content img').length} images`);
        if (popup) await popup.close();
      } catch (error) {
        manifest.failures.push({ ...item, error: error.message });
        console.error(`FAILED ${item.title}: ${error.message}`);
      }
      save();
    }
    manifest.items.sort((a, b) => a.file.localeCompare(b.file));
    save();
    console.log(`Saved: ${dir}; ${manifest.items.length}/${issue.items.length}`);
    if (manifest.failures.length) process.exitCode = 1;
    else if (process.env.ARCHIVE_RESULT_FILE) fs.writeFileSync(process.env.ARCHIVE_RESULT_FILE, JSON.stringify({ issueDir: dir }));
  } finally { await context.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
