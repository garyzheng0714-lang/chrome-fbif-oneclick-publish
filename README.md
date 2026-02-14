# FBIF OneClick Publish Chrome Extension

从公众号/飞书云文档提取内容并同步到 FoodTalks 后台的 Chrome 扩展。

## 功能概览

- 点击扩展图标，直接打开独立全屏分发页面（非 popup）
- 输入公众号文章链接，自动提取标题、封面、正文和图片顺序
- 飞书文档提取支持双策略：`OpenAPI 精准提取 -> 页面 DOM 兜底`
- 飞书富文本格式适配：支持加粗/斜体/超链接/标题层级、列表、表格、并排布局、引用块、Callout、嵌入链接
- 表格适配支持列宽、合并单元格、单元格文本对齐；图片支持备注（caption）自动绑定
- 通用兜底已覆盖：代码块、任务列表、分割线、附件卡片、未知块占位与告警提示
- 提取后展示完整性校验（字数、图片数、段落数、缺失项）
- 页面简化为单流程：`链接提取 -> 正文预览 -> 同步 FoodTalks`
- 一键触发 FoodTalks 后台「公众号文章采集」，失败时自动回退为手动填充标题/正文
- 支持两种同步动作：`同步并保存草稿` / `同步并直接发布`
- 同步失败自动回退草稿，支持一键复制
- 缓存、重试、超时控制与日志追踪
- 平台模块化架构（当前仅保留 `foodtalks` 模块，结构可扩展）

## 目录结构

- `manifest.json`: MV3 扩展配置
- `background.js`: 提取/缓存/发布/日志的后台编排
- `app.html`: 主分发页
- `fallback.html`: 发布失败的草稿回退页
- `styles/app.css`: UI 样式
- `styles/vendor/pico.min.css`: Pico CSS（开源组件库样式基础）
- `src/app.js`: 页面业务逻辑
- `src/platforms.js`: 平台配置（当前仅 `foodtalks`）
- `src/sources/feishu/*`: 飞书来源模块（API 客户端、块渲染、图片下载）
- `src/publishers/foodtalks/*`: FoodTalks 模块化实现（extractor/content/image/publish）
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
- 先填写飞书 `App ID / App Secret` 并保存（仅本地存储）
- 在全屏页面输入公众号/飞书文档链接并提取
- 预览后点击“同步并保存草稿”或“同步并直接发布”

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

- FoodTalks 后台若触发风控或登录失效，会导致自动同步失败，请先在同域保持登录状态。
- 后台页面改版后，需更新 `src/publishers/foodtalks/selectors.js` 选择器表。
