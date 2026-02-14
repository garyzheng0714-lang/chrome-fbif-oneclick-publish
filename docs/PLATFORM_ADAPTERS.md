# 平台级适配表（当前版本）

## 当前目标

本版本仅保留 **FoodTalks** 一个目标平台：

- 发布地址：`https://admin-we.foodtalks.cn/#/radar/news/publish`
- 来源输入：微信公众号文章链接（`mp.weixin.qq.com`）

## 模块目录

- `src/publishers/foodtalks/extractor.js`
- `src/publishers/foodtalks/content-processor.js`
- `src/publishers/foodtalks/image-processor.js`
- `src/publishers/foodtalks/publish-api.js`
- `src/publishers/foodtalks/selectors.js`

## 关键适配点

- 优先触发后台原生按钮：`公众号文章采集`（`.get-essay`）
- 采集弹窗输入框：`input[placeholder*="微信公众号文章网址"]`
- 采集确认按钮：`.get-essay-dialog .el-button--primary`（文本 `确认`）
- 标题字段：按表单标签 `标题` 定位对应 `input`
- 正文字段：优先 `tinymce` 编辑器实例，其次 `iframe.tox-edit-area__iframe` / `contenteditable`
- 草稿按钮：`.draft-button`（文本 `保存草稿`）
- 发布按钮：`.publish-button`（文本 `发布` / `保存并发布`）

## 失败回退策略

- 若“公众号文章采集”按钮或弹窗不可用，自动回退到手动填充标题/正文。
- 若正文编辑器实例未定位，返回告警并保留页面给人工接管。
- 若登录态失效（命中 `#/login` 或密码输入框），直接失败并提示先登录。
