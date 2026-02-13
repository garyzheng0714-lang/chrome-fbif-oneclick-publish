# 平台级适配表

## 适配策略

- 采用“平台专属 + 通用兜底”双层选择器。
- 采用动态等待与节点打分：优先命中可见、面积更大、语义更接近（标题/正文）的节点。
- 参考 Wechatsync 的平台适配思路，按平台分离“内容转换”和“图片处理”链路。
- 知乎：正文写入前先调用 `POST https://zhuanlan.zhihu.com/api/uploaded_images` 上传外链图，再把正文里的 `<img src>` 替换为知乎图床地址。
- 小红书：优先进入“新的创作”态，再注入富文本；对正文图片做 data URI 兜底，减少微信外链图在目标平台失效的问题。

## 适配清单

| 平台 | 发布地址 | 标题选择器（主） | 正文选择器（主） | 封面选择器 | 内容策略 | 备注 |
|---|---|---|---|---|---|---|
| 小红书 | `https://creator.xiaohongshu.com/publish/publish?from=tab_switch&target=article` | `textarea[placeholder*="标题"]` / `input[placeholder*="标题"]` / `[data-placeholder*="标题"]` | `.tiptap.ProseMirror` / `.ProseMirror` / `[contenteditable="true"]` | `input[placeholder*="封面"]` 等 | 富文本优先 | 图片做 data URI 兜底 |
| 知乎 | `https://zhuanlan.zhihu.com/p/2005305520517572521/edit` | `h1[contenteditable="true"]` / `.TitleInput-input` | `.RichText.ztext[contenteditable="true"]` / `[data-lexical-editor="true"]` | `input[placeholder*="封面"]` 等 | 富文本 + 图床替换 | 外链图先上传知乎 |
| 今日头条 | `https://mp.toutiao.com/profile_v4/graphic/publish` | `input[placeholder*="标题"]` / `.title-input input` | `.ql-editor` / `.ProseMirror` / `.byted-editor-content` | `input[placeholder*="封面"]` 等 | 富文本 | 平台改版后需更新 |
| 百家号 | `https://baijiahao.baidu.com/builder/rc/edit` | `input[placeholder*="标题"]` / `.article-title input` | `.ql-editor` / `.ProseMirror` / `.editor-content [contenteditable="true"]` | `input[placeholder*="封面"]` 等 | 富文本 | 平台改版后需更新 |
| B站专栏 | `https://member.bilibili.com/platform/upload/text/edit` | `input[placeholder*="标题"]` / `.article-title input` | `.ql-editor` / `.ProseMirror` / `.article-content [contenteditable="true"]` | `input[placeholder*="封面"]` 等 | 富文本 | 平台改版后需更新 |

## 运行时行为

- 若检测到登录页（URL 包含 `login/signin/passport` 或页面出现密码框/登录容器），直接返回失败并提示先登录。
- 封面控件缺失不会阻断标题/正文填充，会保留警告并进入回退草稿。
- 跟随跳转开启时，每个平台会自动切换到对应标签页进行填充。
