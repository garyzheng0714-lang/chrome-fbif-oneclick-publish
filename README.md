# FBIF OneClick Publish Chrome Extension

全平台内容分发 Chrome 扩展，面向微信公众号文章的一键提取、富文本编辑和多平台同步发布。

## 功能概览

- 点击扩展图标，直接打开独立全屏分发页面（非 popup）
- 输入公众号文章链接，自动提取标题、封面、正文和图片顺序
- 提取后展示完整性校验（字数、图片数、段落数、缺失项）
- 右侧富文本编辑器支持：
  - 保留原始 HTML 结构与常见格式
  - 加粗/斜体/标题层级/列表/链接
  - 撤销、重做、格式刷、全屏编辑
  - 图片替换、删除、宽度调节
- 底部分发支持多选平台：小红书、知乎、今日头条、百家号、B站专栏
- 同步发布时依次打开平台发布页并自动填充
- 发布失败自动回退草稿，支持一键复制
- 缓存、重试、超时控制与日志追踪

## 目录结构

- `manifest.json`: MV3 扩展配置
- `background.js`: 提取/缓存/发布/日志的后台编排
- `app.html`: 主分发页
- `fallback.html`: 发布失败的草稿回退页
- `styles/app.css`: UI 样式
- `src/app.js`: 页面业务逻辑
- `src/editor.js`: 富文本编辑能力
- `src/platforms.js`: 平台配置
- `scripts/package-extension.mjs`: ZIP + CRX 打包脚本
- `docs/USAGE.md`: 使用说明
- `docs/TEST_REPORT.md`: 测试报告（10 个链接样本）
- `docs/PLATFORM_ADAPTERS.md`: 平台级适配表（选择器与策略）

## 本地运行

1. 安装依赖

```bash
npm install
```

2. 本地加载扩展

- 打开 Chrome `chrome://extensions`
- 开启“开发者模式”
- 选择“加载已解压的扩展程序”
- 选择项目根目录

3. 使用扩展

- 点击工具栏扩展图标
- 在全屏分发页中输入公众号链接并提取
- 编辑内容后勾选平台并点击“同步发布”

## 打包产物

```bash
npm run package
```

打包后在 `dist/` 生成：

- `dist/fbif-oneclick-publish.zip`
- `dist/fbif-oneclick-publish.crx`
- `dist/extension/`（可直接加载的解压目录）
- `.keys/fbif-oneclick-publish.pem`（CRX 私钥）

## 测试

```bash
npm test
```

## 注意事项

- 平台发布页面会频繁改版，自动填充依赖 DOM 选择器，建议定期更新适配器。
- 第三方平台登录态、风控与验证码会影响自动发布成功率。
- 由于浏览器安全限制，部分平台封面上传控件不可直接自动写入文件，系统会保留封面链接并提示手动上传。
