# 平台适配表（当前版本）

## 目标平台

- 平台：FoodTalks
- 发布地址：`https://admin-we.foodtalks.cn/#/radar/news/publish`

## 来源范围

- 仅支持飞书文档：`https://*.feishu.cn/docx/...`、`https://*.feishu.cn/wiki/...`

## 模块目录

- `src/publishers/foodtalks/extractor.js`
- `src/publishers/foodtalks/content-processor.js`
- `src/publishers/foodtalks/image-processor.js`
- `src/publishers/foodtalks/publish-api.js`
- `src/publishers/foodtalks/selectors.js`

## 发布策略

- 默认：半自动（复制代码 + 打开登录页 + 人工确认）
- 高级（Beta）：自动保存草稿 / 自动发布

## 失败回退

- 自动流程失败时，生成回退草稿并提供复制入口。
- 登录态缺失时，提示 `FT_LOGIN_REQUIRED` 并提供“去登录”动作。
