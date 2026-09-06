# 财新周刊个人归档工具

这是一个面向个人离线阅读和个人文本研究的 Windows 工作流。它复用你自己已经登录的财新账号，抓取当前账号有权阅读的某一期周刊文章，然后生成 EPUB、PDF、UTF-8 TXT 和约 200 字的整期摘要。

项目不会破解验证码、绕过付费权限、逆向私有接口或共享账号。登录信息只保存在本机的专用 Chrome 用户目录中。

## 工作方式

完整流程分为三步：

1. 使用项目专用的 Chrome 配置目录手动登录财新。
2. Playwright 复用登录状态，从某一期周刊页面收集并清洗文章。
3. 根据本地文章归档生成 EPUB、适合打印批注的 PDF，以及便于文本处理的 TXT。

抓取结果保存在 `archive/<财新或三联>/<年份及期号>/`，成品按 `output/<财新或三联>/<年份及期号>/` 保存。同一期五种文件直接放在一起，摘要使用 `.summary.txt` 后缀与全文 TXT 区分：

```text
output/
  财新/
    2026年第35期/
      财新周刊-2026年35期.epub
      财新周刊-2026年35期.pdf
      财新周刊-2026年35期.txt
      财新周刊-2026年35期.summary.txt
      封面.jpg
  三联/
    2026年第35期/
      三联生活周刊 2026年第35期 在大学 这样成人.epub
      三联生活周刊 2026年第35期 在大学 这样成人.pdf
      三联生活周刊 2026年第35期 在大学 这样成人.txt
      三联生活周刊 2026年第35期 在大学 这样成人.summary.txt
      封面.jpg
```

采集、归档及构建命令均使用 `--publication caixin` 或 `--publication lifeweek`；也接受 `财新` / `三联`。构建未指定期目录时只选该期刊最近采集的期；一键归档始终使用本次采集的确切目录。

## 环境准备

- Windows
- Node.js 20 或更高版本
- pnpm 10.14.0（可通过 Node.js 自带的 Corepack 启用）
- Google Chrome；无法启动时可按配置回退到 Edge 或 Playwright Chromium
- 已安装并登录 Codex CLI（用于生成整期摘要）

启用项目声明的 pnpm 版本：

```powershell
corepack enable
```

安装项目依赖：

```powershell
pnpm install
```

当前 EPUB、PDF 和 TXT 都由项目直接生成，不需要安装 Calibre。

## 第一次登录

使用独立的浏览器目录打开 Chrome：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\open_chrome_profile.ps1
```

在打开的 Chrome 中：

1. 登录自己的财新账号。
2. 打开一篇自己有权阅读的文章，确认能看到完整正文。
3. 关闭这个 Chrome 窗口。

后续抓取会复用 `./profile` 中的登录状态。不要把 `profile` 目录提交到 Git，也不要与他人共享。

如果抓取时提示浏览器配置目录正在使用，请先关闭所有通过这个专用目录打开的 Chrome 窗口。

## 一次生成某一期的 EPUB、PDF 和 TXT

推荐直接执行：

```powershell
pnpm run archive -- --publication caixin "https://weekly.caixin.com/..."
pnpm run archive -- --publication lifeweek "https://www.lifeweek.com.cn/magazine/5254"
```

参数应当是目标期刊的目录页或专题页 URL。命令会依次：

1. 抓取文章并写入 `archive/<财新或三联>/<年份及期号>/`。
2. 将期刊封面原图保存到 该期成品目录。
3. 生成 EPUB。
4. 生成 PDF。
5. 生成 TXT。
6. 分析该期 TXT，并生成约 200 字的中文摘要。

任何一步失败都会停止，不会把不完整的后续文件误报为成功。

## 分步执行

### 三联生活周刊试用

在同一个 `./profile` Chrome 中登录三联生活周刊会员账号，确认正文可读后关闭该窗口。三联使用独立采集入口，复用现有 PDF / EPUB 排版和输出目录：

```powershell
pnpm run fetch:lifeweek -- "https://www.lifeweek.com.cn/magazine/5254"
pnpm run build:epub -- --publication lifeweek "./archive/三联/2026年第35期"
pnpm run build:pdf -- --publication lifeweek "./archive/三联/2026年第35期"
```

采集保存目录中的全部文章卡片（包括翻页图集），保留栏目、原文链接、期刊日期、正文 HTML 和封面。`manifest.json` 中记录预期篇数与失败条目；采集有失败时返回非零状态，可以在采集命令末尾加 `--resume` 补抓，再导出。日期是期刊出版日期。音频、视频及评论不包含在阅读版中。PDF 是网站正文重新排版的阅读版，不是纸刊原版扫描。三联已接入 `archive`，可一次生成全部五类文件。

只抓取文章：

```powershell
pnpm run fetch -- --publication caixin "https://weekly.caixin.com/..."
```

如果某一期抓取过程中有文章因页面加载异常被跳过，可以断点续抓：

```powershell
pnpm run fetch -- --publication caixin "https://weekly.caixin.com/..." --resume
```

断点模式会复用 `manifest.json` 中已经成功保存的文章，只为缺失链接启动隔离浏览器重试。补抓完成后，再运行 EPUB、PDF 和 TXT 生成命令覆盖原成品。

使用最近一次抓取结果生成 EPUB：

```powershell
pnpm run build:epub -- --publication caixin
```

使用最近一次抓取结果生成 PDF：

```powershell
pnpm run build:pdf -- --publication caixin
```

使用最近一次抓取结果生成 TXT：

```powershell
pnpm run build:txt -- --publication caixin
```

使用最近生成的 TXT 生成整期摘要：

```powershell
pnpm run build:summary -- --publication caixin
```

为所选期刊的各期生成摘要（须先生成 TXT）：

```powershell
pnpm run build:summary:all -- --publication caixin
```

也可以明确指定某一期的临时目录：

```powershell
pnpm run build:epub -- --publication caixin ".\archive\财新\2026年第10期"
pnpm run build:pdf -- --publication caixin ".\archive\财新\2026年第10期"
pnpm run build:txt -- --publication caixin ".\archive\财新\2026年第10期"
```

这样可以在不重新访问财新网站的情况下，反复调整并重新生成阅读文件。

## 输出内容

### 抓取归档

每篇文章保存为独立 HTML，同时生成 `manifest.json`，其中记录：

- 期刊名称和来源页面
- 文章标题、栏目、作者和日期
- 文章原始 URL
- 正文长度
- 是否点击过“展开全文”

抓取过程会自动滚动页面、尝试点击“余下全文”“展开全文”“阅读全文”，并兼容“余下全文”跳转到第二页的旧式分页文章。自动滚动设有最长时限，避免推荐内容持续加载导致单篇文章无限等待。抓取时会过滤广告、推荐阅读、相关报道、页面导航、“融媒精选”，以及网页中供 AI 抓取器读取的总结提示等非正文内容。“一周回溯”等以图片承载主要内容的页面，即使正文文字为零，也会保留登录后加载的真实文章图片；CSS 防复制水印不会被当作正文。对于“显影”等没有普通 `<h1>` 的互动页面，会依次使用期刊目录标题、Open Graph 标题和网页标题作为备用。普通模式下单篇文章首次失败后会使用新的浏览器页面重试，其余文章继续处理。

### EPUB

EPUB 使用该期财新周刊的原版封面，并包含文章目录、正文和下载到本地的文章图片，适合电子书阅读器使用。原版封面同时写入 EPUB 封面元数据，阅读器书架可以直接显示。

### PDF

PDF 使用 A4 版式，包含：

- 该期财新周刊的原版封面页
- 可点击目录
- 每篇文章从新页开始
- 作者、栏目和日期信息
- 内嵌图片
- 页码和 PDF 书签

PDF 由无界面的 Chrome 排版生成，中文字体使用系统字体，无需额外安装转换软件。

### TXT

TXT 使用 UTF-8 编码，每一期生成一个纯文本文件。文件按期刊原顺序排列文章，并保留标题、栏目、作者和日期；图片、网页样式、脚本和链接地址不会写入语料。文章之间使用稳定的编号分隔，便于后续合并、切分、分词或转换为 nanoGPT 等训练流程需要的输入格式。

TXT 适合作为个人研究语料的基础版本，但在用于模型训练前仍建议根据目标任务完成去重、训练集与验证集划分、版权和隐私检查。不要把生成的全文语料公开发布或分享给无权访问的人。

### 整期摘要

摘要步骤读取该期 TXT，从每篇文章提取标题、栏目和代表性正文，再由已登录的 Codex CLI 归纳为约 200 字的一段式中文概述，保存到 该期成品目录（`.summary.txt`）。摘要会尽量覆盖该期最重要的三至五条主线，而不是逐篇罗列标题。

默认使用 Codex 当前配置的模型，不需要把 API 密钥写入项目。可以通过 `summaryTargetChars` 调整目标字数，通过 `summaryArticleExcerptChars` 调整每篇文章用于分析的正文长度；如需固定模型，可在本机 `config.json` 中增加 `summaryModel`。AI 摘要可能出现遗漏，重要事实仍应回看原文核对。

## 常用配置

主要配置位于 `config.json`，可以从 `config.example.json` 重新复制一份。也可以通过 `CAIXIN_CONFIG` 环境变量使用另一份配置文件。

- `issueUrl`：没有传命令参数时使用的期刊页面。
- `profileDir`：保存财新登录状态的专用浏览器目录。
- `articleLimit`：单期最多抓取文章数。
- `targetSections`：需要识别的栏目。
- `sectionDownloadOrder`：文章下载和成书顺序。
- `selectors`：标题、作者、日期和正文的 CSS 选择器。
- `selectors.issueCover`：从期刊目录页识别原版封面的 CSS 选择器。
- `removeSelectors`：从正文中删除的页面元素。
- `minBodyTextLength`：认为正文已经基本加载完成的长度。
- `headless`：抓取时是否隐藏浏览器窗口；调试建议设为 `false`。
- `noProxy` / `proxyServer`：直连或指定代理。
- `summaryTargetChars`：摘要目标字数，默认约 200 字。
- `summaryArticleExcerptChars`：每篇文章用于摘要分析的正文节选长度。
- `summaryReasoningEffort`：Codex 生成摘要时的推理强度。
- `pdf`：PDF 纸张大小和页边距。
- `imageDownloadTimeoutMs`：单张图片下载超时。
- `imageDownloadConcurrency`：生成 PDF 时并行下载图片的数量。

页面结构变化时，优先修改选择器和过滤配置，再考虑修改代码。

## 推荐检查顺序

第一次抓取某一期时建议：

1. 确认专用 Chrome 中的登录状态仍有效。
2. 执行 `fetch`，观察识别出的文章数量和栏目。
3. 随机打开 `archive/<财新或三联>/<年份及期号>/` 中的几篇 HTML，检查正文是否完整。
4. 查看 `manifest.json`，确认没有广告页或栏目页。
5. 再生成 EPUB、PDF 和 TXT。

## 常见问题

### 没有找到文章链接

确认传入的是具体期刊的目录页，并检查 `targetSections`、`articleAllowDomains` 和 `articleUrlPatterns`。

### 正文缺失或只有摘要

先在专用 Chrome 中确认账号能查看完整文章，然后调整 `selectors.articleContent`、`articleLoadPasses` 或正文长度阈值。

### 混入了无关文章

缩小 `targetSections` 和允许域名，补充 `skipTitleKeywords`，或者降低 `articleLimit`。

### 图片下载失败

文章和文档仍会继续生成。检查网络设置，必要时提高 `imageDownloadTimeoutMs` 或配置 `proxyServer`。

### PDF 生成失败

确认 Chrome 或 Edge 已安装。如果只想重新生成 PDF，可以直接指定已经存在的 `archive/<财新或三联>/<年份及期号>` 目录，不需要重新抓取。

## 使用边界

本工具只适合归档自己账号合法可访问的内容，用于个人离线阅读。请遵守财新的服务条款和版权要求，不要公开传播生成文件或用于批量镜像。

旧版五个格式目录配置已由 `outputDir` 统一替代。`issueLabels` 可为历史日期标题指定已核实的年份期号；本地封面已确认 `财新周刊_2026-03-15` 为 `2026年第09期`。

原始文章 HTML 与 `manifest.json` 持久保存在 `archive/财新或三联/YYYY年第NN期/`，由 `archiveDir` 配置。重建与断点续抓读取此目录。`tmp/` 仅保存测试、校验及迁移过程文件，任务结束后可清理，不参与正式重建。`archive/` 与账号资料一样不提交 Git；备份时应保留。
