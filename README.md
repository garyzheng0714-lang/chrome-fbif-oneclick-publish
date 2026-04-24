# FBIF OneClick Publish Chrome Extension

飞书云文档到 FoodTalks / 微信公众号后台的同步助手。扩展提供轻量弹窗、同步页和专业工作台三种入口，用于提取飞书文档内容、预览和校验文章，并将内容适配到目标发布平台。

## 当前产品边界

- 来源：飞书云文档链接，重点支持 `docx` / `wiki` 文档。
- 目标平台：FoodTalks 后台和微信公众号后台。
- 运行形态：Chrome Manifest V3 扩展。
- 默认流程：弹窗识别链接 -> 打开同步页 -> 提取内容 -> 选择目标平台 -> 同步或填充。

## 关键能力

- 弹窗入口：识别飞书链接并打开同步页。
- 同步页：按 `提取 -> 选择目标 -> 同步` 的流程处理文章。
- 专业工作台：提供内容预览、编辑、统计、完整性校验、运行日志和恢复动作。
- 飞书内容提取：OpenAPI 优先，页面 DOM 作为兜底。
- 图片处理：支持图片拉取、并发控制、重试和 HTML 清洗。
- FoodTalks 适配：生成适合 FoodTalks 粘贴 / 发布流程的内容。
- 微信公众号适配：构建公众号编辑页所需 HTML，并通过分片传输处理大内容。
- 任务记录：保存最近任务和最近配置，支持重跑。
- 错误处理：错误码、原因和推荐下一步集中映射。

## 技术栈

- Chrome Manifest V3
- 原生 JavaScript ES Modules
- Web Worker
- Pico CSS
- Node.js 测试工具链（`node --test`、jsdom）
- 打包脚本：`archiver`、`crx3`、`fs-extra`

## 项目结构

```text
.
├── manifest.json                    # Chrome MV3 配置
├── background.js                    # 后台服务入口
├── popup.html                       # 轻量弹窗
├── panel.html                       # 同步页
├── app.html                         # 专业工作台
├── fallback.html                    # 降级页面
├── src/
│   ├── background/                  # 后台编排、注入脚本、分片传输
│   ├── publishers/                  # FoodTalks / 公众号发布适配
│   ├── shared/                      # HTML、缓存、错误映射、状态机等共享模块
│   ├── sources/                     # 飞书来源提取
│   └── workers/                     # 公众号 HTML Worker
├── styles/
├── tests/
├── docs/
└── README.md
```

## 权限说明

扩展在 `manifest.json` 中声明以下能力：

- `tabs` / `windows`：管理同步页和目标平台页面。
- `storage`：保存凭据、任务记录和配置。
- `scripting` / `activeTab`：向当前页面注入提取或填充脚本。
- `clipboardWrite`：支持复制适配后的内容。
- Host permissions：访问飞书 / Lark、FoodTalks 和微信公众号相关页面。

## 本地安装

```bash
npm install
```

加载扩展：

1. 打开 `chrome://extensions`。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择本仓库根目录。

## 使用流程

1. 点击扩展图标打开弹窗。
2. 在凭据设置面板中填写并保存飞书 `App ID` / `App Secret`。
3. 输入或确认飞书文档链接。
4. 点击“提取并打开同步页”。
5. 在同步页选择 FoodTalks 或微信公众号。
6. 根据目标平台状态完成复制、跳转、填充或发布操作。

专业工作台（`app.html`）适合更长内容或需要人工检查的流程，可用于：

- 内容预览和手动编辑
- 字数、图片和段落统计
- 完整性校验
- 自动保存草稿 / 自动发布相关实验能力
- 环境检查、运行日志和失败恢复

## 常用命令

```bash
npm test
npm run benchmark:wechat-sync
npm run package
```

说明：

- `npm test` 使用 Node.js 内置测试运行 `tests/*.test.mjs`。
- `npm run benchmark:wechat-sync` 运行微信公众号同步性能基准。
- `npm run package` 调用 `scripts/package-extension.mjs` 打包扩展。

## 文档

- [docs/USAGE.md](./docs/USAGE.md)：使用说明
- [docs/PLATFORM_ADAPTERS.md](./docs/PLATFORM_ADAPTERS.md)：平台适配说明
- [docs/FEISHU_TO_FOODTALKS_MAPPING.md](./docs/FEISHU_TO_FOODTALKS_MAPPING.md)：飞书到 FoodTalks 字段 / 内容映射
- [docs/TEST_REPORT.md](./docs/TEST_REPORT.md)：测试报告

## 注意事项

- 飞书应用凭据和目标平台登录状态均保存在本地浏览器环境，请勿提交个人凭据。
- 微信公众号自动填充依赖目标页面结构和当前登录状态；页面变更时需要重新验证选择器和填充顺序。
- FoodTalks 和微信公众号发布链路涉及外部后台，运行前建议先用测试文章验证。
