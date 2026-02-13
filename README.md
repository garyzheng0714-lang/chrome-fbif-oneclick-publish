# FBIF OneClick Publish Chrome Extension

全平台内容分发 Chrome 扩展，面向微信公众号文章的一键提取、正文预览和多平台同步发布。

## 功能概览

- 点击扩展图标，直接打开独立全屏分发页面（非 popup）
- 输入公众号文章链接，自动提取标题、封面、正文和图片顺序
- 提取后展示完整性校验（字数、图片数、段落数、缺失项）
- 页面简化为单流程：`链接提取 -> 正文预览 -> 平台发布`
- 底部分发支持多选平台：小红书、知乎、今日头条、百家号、B站专栏
- 同步发布时依次打开平台发布页并自动填充
- 发布失败自动回退草稿，支持一键复制
- 缓存、重试、超时控制与日志追踪
- 平台模块化架构（每个平台独立 `extractor / content-processor / image-processor / publish-api`）
- 知乎改为通用写作入口（`https://zhuanlan.zhihu.com/write`），自动创建草稿后跳转可编辑页
- 小红书图片采用“后台预拉取 + 文件输入上传（失败降级粘贴）”策略，降低微信外链失效概率

## 目录结构

- `manifest.json`: MV3 扩展配置
- `background.js`: 提取/缓存/发布/日志的后台编排
- `app.html`: 主分发页
- `fallback.html`: 发布失败的草稿回退页
- `styles/app.css`: UI 样式
- `styles/vendor/pico.min.css`: Pico CSS（开源组件库样式基础）
- `src/app.js`: 页面业务逻辑
- `src/platforms.js`: 平台配置
- `src/publishers/*`: 平台模块化实现（小红书、知乎、头条、百家号、B站）
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
- 预览提取结果后勾选平台并点击“同步发布”

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
