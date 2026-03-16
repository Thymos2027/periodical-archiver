# 财新周刊个人归档工具

这个项目提供一套 **Windows + Chrome + Playwright + Calibre** 的个人工作流：

- 你先手动登录自己的财新账号
- 脚本只复用这份本机登录态
- 按“单期周刊”抓取你当前能访问到的文章页面
- 合成为一个 `EPUB` 放到阅读器里阅读

这套方案默认按 **个人离线阅读** 设计，不包含验证码破解、接口逆向、批量镜像或账号共享。

## 1. 环境准备

- 安装 `Node.js 20+`
- 安装 `Google Chrome`
- 安装 `Calibre`

安装依赖：

```powershell
npm install
```

默认已经附带 `config.json`，你也可以用 `config.example.json` 重新覆盖生成一份。

## 2. 登录专用 Chrome 配置

先开一个专用的 Chrome 用户目录，不要直接复用你日常的默认配置。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\open_chrome_profile.ps1
```

然后：

- 在新开的 Chrome 里登录财新账号
- 打开一篇你有权限查看的文章，确认能正常阅读
- 关闭这个 Chrome 窗口

后面 Playwright 会复用 `./profile` 里的登录态。

## 3. 调整配置

先编辑 `config.json`：

- `issueUrl`：本期周刊目录页或专题页 URL
- `headless`：调试时建议 `false`
- `articleLimit`：单期最多抓多少篇
- `selectors.articleContent`：如果正文提取不准，优先调整这个

如果页面结构和默认选择器不一致，优先改 `config.json`，不要先改代码。

## 4. 抓取单期文章

把本期目录页 URL 作为参数传进去：

```powershell
npm run fetch -- "https://weekly.caixin.com/"
```

运行结果：

- 原始 HTML 存在 `tmp/<期刊目录>/`
- 文章列表写入 `tmp/<期刊目录>/manifest.json`

第一次建议只抓 1 期，确认：

- 候选文章链接是否准确
- 正文区域是否正确
- 是否混入推荐页/广告页/栏目页

## 5. 生成 EPUB

抓取完成后执行：

```powershell
npm run build:epub
```

或者显式指定某一期的临时目录：

```powershell
npm run build:epub -- ".\tmp\财新周刊_2026-03-11"
```

输出文件在 `output/`。

## 6. 推荐调试顺序

1. 先确认登录态有效
2. 跑 `fetch` 看控制台打印的候选文章
3. 检查 `tmp/.../*.html` 的正文是否完整
4. 再跑 `build:epub`

## 7. 常见问题

### Chrome 已经打开，脚本启动失败

关闭所有使用 `./profile` 这个用户目录启动的 Chrome 窗口后再跑。

### 抓到了很多无关链接

改 `config.json`：

- 缩小 `issueLinkTextAllow`
- 缩小 `articleAllowDomains`
- 降低 `articleLimit`

### 正文提取不完整

优先修改 `config.json:selectors.articleContent`。

### 找不到 `ebook-convert.exe`

设置环境变量：

```powershell
$env:CALIBRE_EBOOK_CONVERT="C:\Program Files\Calibre2\ebook-convert.exe"
```

## 8. 一次性跑完

```powershell
npm run archive -- "https://weekly.caixin.com/"
```

## 9. 后续可继续加的能力

- 根据目录页结构做更精确的链接筛选
- 自动下载封面图并嵌入 `EPUB`
- 增加去重逻辑，避免重复归档同一期
- 接入 Windows 任务计划程序做每周检查
