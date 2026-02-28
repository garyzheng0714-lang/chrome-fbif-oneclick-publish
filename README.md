# FBIF OneClick Publish Chrome Extension

飞书文档到 FoodTalks / 公众号 的小弹窗同步插件。

## 当前产品边界

- 来源：仅支持飞书文档（`docx` / `wiki`）
- 目标平台：支持 FoodTalks 与公众号
- 入口：点击扩展图标打开小弹窗（`popup.html`）
- 默认流程：提取 → 选择目标 → 同步

## 关键能力

- 弹窗单按钮状态流转：`提取` → `选择目标后同步`
- 提取过程无文字进度条（0%-100%）
- 飞书提取双策略：OpenAPI 优先，页面 DOM 兜底
- 图片拉取与 HTML 清洗，输出适配 FoodTalks 粘贴代码
- 公众号自动同步状态：待登录 / 待编辑页 / 填充中 / 已完成 / 失败
- 任务记录（最近 20 条）与最近配置重跑
- 失败恢复动作：错误码 + 原因 + 推荐下一步

## 目录（核心）

- `manifest.json`：MV3 配置
- `background.js`：提取/发布/检查/日志编排
- `popup.html`：小弹窗页面
- `src/popup.js`：弹窗状态逻辑
- `src/shared/foodtalks-html.js`：共享 HTML 处理模块
- `src/shared/wechat-html.js`：公众号 HTML 处理模块
- `src/shared/error-mapping.js`：错误码与恢复动作映射
- `src/sources/feishu/*`：飞书提取与图片下载
- `src/publishers/foodtalks/*`：FoodTalks 发布适配
- `src/publishers/shared/wechat-urls.js`：公众号 URL 判断与编辑页跳转

## 本地运行

```bash
npm install
```

加载扩展：

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择项目根目录

## 使用方式

1. 点击扩展图标，打开弹窗
2. 填写并保存飞书 `App ID / App Secret`
3. 输入飞书文档链接并点击“提取内容”
4. 在同步页选择目标（FoodTalks 或公众号）
5. FoodTalks：复制代码并打开登录页（新标签）
6. 公众号：自动检测登录并等待编辑页，随后自动填充标题与正文

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
