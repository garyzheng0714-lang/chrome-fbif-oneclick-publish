# 平台级适配表

## 适配策略

- 采用“平台专属 + 通用兜底”双层选择器。
- 采用动态等待与节点打分：优先命中可见、面积更大、语义更接近（标题/正文）的节点。
- 参考 Wechatsync 的平台适配思路，按平台分离“内容转换”和“图片处理”链路。
- 知乎：优先走草稿 API（创建/更新草稿）并在写入前调用 `POST https://zhuanlan.zhihu.com/api/uploaded_images` 上传外链图。
- 小红书：优先进入“新的创作”态，先写入正文文本，再走“文件输入控件上传”，失败时降级为粘贴文件事件。

## 模块目录

每个平台独立目录，统一为 4 个模块：

- `extractor.js`：平台内容提取与输入归一化
- `content-processor.js`：正文结构清洗与平台规则处理
- `image-processor.js`：图片上传/替换策略
- `publish-api.js`：页面注入与发布接口

目录示例：

- `src/publishers/zhihu/*`
- `src/publishers/xiaohongshu/*`
- `src/publishers/toutiao/*`
- `src/publishers/baijiahao/*`
- `src/publishers/bilibili/*`

## 适配清单

| 平台 | 发布地址 | 标题选择器（主） | 正文选择器（主） | 封面选择器 | 内容策略 | 备注 |
|---|---|---|---|---|---|---|
| 小红书 | `https://creator.xiaohongshu.com/publish/publish?from=tab_switch&target=article` | `textarea[placeholder*="标题"]` / `input[placeholder*="标题"]` / `.d-text` | `.ql-editor` / `.tiptap.ProseMirror` / `.ProseMirror` / `[contenteditable="true"]` | `input.upload-input[type="file"]` / `input[type="file"][accept*="image"]` | 文本 + 本地文件图片上传 | 先后台拉取公众号图片并转 data URL，再注入上传 |
| 知乎 | `https://zhuanlan.zhihu.com/write` | `h1[contenteditable="true"]` / `.Post-Title h1[contenteditable="true"]` | `.RichText.ztext[contenteditable="true"]` / `.DraftEditor-root div[contenteditable="true"]` | 草稿 API 写入 | 草稿 API + 图床替换 | 草稿生成后跳转 `.../p/{draftId}/edit` 继续编辑发布 |
| 今日头条 | `https://mp.toutiao.com/profile_v4/graphic/publish` | `input[placeholder*="标题"]` / `.title-input input` | `.ql-editor` / `.ProseMirror` / `.byted-editor-content` | `input[placeholder*="封面"]` 等 | 富文本 | 平台改版后需更新 |
| 百家号 | `https://baijiahao.baidu.com/builder/rc/edit` | `input[placeholder*="标题"]` / `.article-title input` | `.ql-editor` / `.ProseMirror` / `.editor-content [contenteditable="true"]` | `input[placeholder*="封面"]` 等 | 富文本 | 平台改版后需更新 |
| B站专栏 | `https://member.bilibili.com/platform/upload/text/edit` | `input[placeholder*="标题"]` / `.article-title input` | `.ql-editor` / `.ProseMirror` / `.article-content [contenteditable="true"]` | `input[placeholder*="封面"]` 等 | 富文本 | 平台改版后需更新 |

## 运行时行为

- 若检测到登录页（URL 包含 `login/signin/passport` 或页面出现密码框/登录容器），直接返回失败并提示先登录。
- 封面控件缺失不会阻断标题/正文填充，会保留警告并进入回退草稿。
- 跟随跳转开启时，每个平台会自动切换到对应标签页进行填充。
