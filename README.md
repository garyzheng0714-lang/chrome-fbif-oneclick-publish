# FBIF OneClick Publish Chrome Extension

飞书文档到 FoodTalks / 公众号 的同步插件，提供轻量弹窗与专业工作台两种入口。

## 当前产品边界

- 来源：仅支持飞书文档（`docx` / `wiki`）
- 目标平台：支持 FoodTalks 与公众号
- 入口：
  - 点击扩展图标打开轻量弹窗（`popup.html`），一键跳转同步页（`panel.html`）
  - 专业工作台（`app.html`）：提取、预览、校验、自动发布一站式操作
- 默认流程：弹窗识别链接 → 打开同步页 → 提取 → 选择目标 → 同步

## 关键能力

- 弹窗作为启动器：识别飞书链接后打开同步页
- 同步页单按钮状态流转：`提取` → `选择目标后同步`，提取过程按钮显示文字进度（0%-100%）
- 飞书提取双策略：OpenAPI 优先，页面 DOM 兜底
- 图片拉取（含并发控制与重试）与 HTML 清洗，输出适配 FoodTalks 粘贴代码
- 公众号同步全流程状态：待登录 / 待编辑页 / 填充中 / 已完成 / 失败 / 已取消
- 提取结果缓存（按标签页 + URL 双维度），支持重新提取
- 大内容分片传输（content-transfer-service），突破消息大小限制
- 公众号 HTML 在 Web Worker 中离主线程构建
- 专业工作台功能：内容预览与编辑、字数/图片/段落统计、完整性校验、自动保存草稿 / 自动发布（Beta）、环境检查与恢复动作
- 任务记录（最近 20 条）与最近配置重跑
- 失败恢复动作：错误码 + 原因 + 推荐下一步
- 标题层级归一化（heading-normalizer）

## 目录（核心）

- `manifest.json`：MV3 配置
- `background.js`：提取/发布/检查/日志/公众号同步编排
- `popup.html` + `src/popup-launcher.js`：轻量弹窗，识别链接并跳转同步页
- `panel.html` + `src/panel.js`：同步页，提取 → 选择目标 → 同步
- `app.html` + `src/app.js`：专业工作台（提取、预览、校验、自动发布、日志）
- `fallback.html`：降级页面
- `src/shared/foodtalks-html.js`：FoodTalks HTML 处理模块
- `src/shared/wechat-html.js`：公众号 HTML 处理模块
- `src/shared/error-mapping.js`：错误码与恢复动作映射
- `src/shared/popup-flow.js`：同步页状态流转与按钮配置
- `src/shared/popup-extract-cache.js`：提取结果缓存键管理
- `src/shared/workbench-state.js`：工作台状态机与权限
- `src/shared/wechat-sync-payload.js`：公众号同步数据构建
- `src/shared/wechat-sync-transfer.js`：公众号同步分片传输
- `src/shared/wechat-editor-order.js`：公众号编辑页排序签名
- `src/sources/feishu/*`：飞书提取与图片下载
- `src/publishers/foodtalks/*`：FoodTalks 内容处理与发布 API
- `src/publishers/shared/foodtalks-urls.js`：FoodTalks URL 判断与跳转
- `src/publishers/shared/wechat-urls.js`：公众号 URL 判断与编辑页跳转
- `src/publishers/shared/heading-normalizer.js`：标题层级归一化
- `src/publishers/shared/image-fetch.js`：图片拉取
- `src/background/content-transfer-service.js`：大内容分片传输服务
- `src/background/injected/page-scripts.js`：注入目标页面的脚本
- `src/workers/wechat-html.worker.js`：公众号 HTML 构建 Worker

## 本地运行

```bash
npm install
```

加载扩展：

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 选择”加载已解压的扩展程序”
4. 选择项目根目录

## 使用方式

1. 点击扩展图标，打开弹窗
2. 填写并保存飞书 `App ID / App Secret`（凭据设置面板）
3. 确认飞书文档链接后点击”提取并打开同步页”
4. 在同步页选择目标（FoodTalks 或公众号）
5. FoodTalks：复制代码并打开登录页（新标签）
6. 公众号：自动检测登录并等待编辑页，随后自动填充标题与正文

专业工作台（`app.html`）额外支持：

- 内容预览与手动编辑
- 自动保存草稿 / 自动发布（Beta）
- 环境检查与诊断
- 运行日志查看与清空

## 打包

```bash
npm run package
```

## 测试

```bash
npm test
```

性能基准（5 万字 + 50 图）：

```bash
npm run benchmark:wechat-sync
```

## 已知问题

- 暂无阻断性问题。
