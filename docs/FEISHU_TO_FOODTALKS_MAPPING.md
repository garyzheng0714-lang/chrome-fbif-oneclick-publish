# 飞书文档到 FoodTalks HTML 映射对照表

本文档基于当前实现整理，覆盖两层映射：

1. 飞书 Docx Block -> 插件中间 HTML（`src/sources/feishu/extractor.js`）
2. 中间 HTML -> FoodTalks 可粘贴 HTML（`src/app.js` 的 `buildFoodtalksPasteHtml`）

## 1. 块级映射（飞书 Block -> 中间 HTML）

| 飞书块/类型 | 识别规则 | 中间 HTML 输出 | 代码位置 |
| --- | --- | --- | --- |
| 普通段落 | `block_type=2` | `<p>...</p>` | `src/sources/feishu/extractor.js:3-11`, `src/sources/feishu/extractor.js:548-560` |
| 标题1 | `block_type=3` | `<h1>...</h1>` | `src/sources/feishu/extractor.js:3-11`, `src/sources/feishu/extractor.js:548-560` |
| 标题2 | `block_type=4` | `<h2>...</h2>` | 同上 |
| 标题3 | `block_type=5` | `<h3>...</h3>` | 同上 |
| 标题4 | `block_type=6` | `<h4>...</h4>` | 同上 |
| 标题5 | `block_type=7` | `<h5>...</h5>` | 同上 |
| 标题6 | `block_type=8` | `<h6>...</h6>` | 同上 |
| 无序列表项 | `block_type=12` | 外层 `<ul>`, 内层 `<li>...</li>` | `src/sources/feishu/extractor.js:13-16`, `src/sources/feishu/extractor.js:772-842`, `src/sources/feishu/extractor.js:563-578` |
| 有序列表项 | `block_type=13` | 外层 `<ol>`, 内层 `<li>...</li>` | 同上 |
| 图片 | `block_type=27`, `image.token` 有值 | `<figure class="feishu-image"><img data-feishu-token="..." ... /></figure>` | `src/sources/feishu/extractor.js:23`, `src/sources/feishu/extractor.js:347-374` |
| 图片备注（相邻段落） | 图片后一个 `block_type=2`，满足备注规则 | 合并为 `figcaption`：`<figure ...><img ...><figcaption>...</figcaption></figure>` | `src/sources/feishu/extractor.js:309-325`, `src/sources/feishu/extractor.js:327-344`, `src/sources/feishu/extractor.js:815-827` |
| 表格 | `block_type=31` | `<div class="feishu-table-wrap"><table class="feishu-table">...</table></div>`（含 `th/td`、合并单元格） | `src/sources/feishu/extractor.js:24`, `src/sources/feishu/extractor.js:673-770` |
| 表格单元格 | `block_type=32` | 递归渲染 cell 子内容 | `src/sources/feishu/extractor.js:25`, `src/sources/feishu/extractor.js:655-671`, `src/sources/feishu/extractor.js:882-883` |
| 引用容器 | `block_type=34` | `<blockquote class="feishu-quote">...</blockquote>` | `src/sources/feishu/extractor.js:26`, `src/sources/feishu/extractor.js:605-613` |
| Callout | `block_type=19` | `<aside class="feishu-callout" data-emoji="...">...</aside>` | `src/sources/feishu/extractor.js:19`, `src/sources/feishu/extractor.js:594-603` |
| 并排布局（Grid） | `block_type=24` + 列 `25` | `<div class="feishu-grid"> <div class="feishu-grid-col">...</div> ... </div>` | `src/sources/feishu/extractor.js:20-21`, `src/sources/feishu/extractor.js:615-653` |
| Iframe/嵌入 | `block_type=26` | 降级为链接：`<p><a class="feishu-embed-link" ...>url</a></p>` | `src/sources/feishu/extractor.js:22`, `src/sources/feishu/extractor.js:580-592` |
| 代码块 | payload 命中 `code/code_block/pre` | `<pre class="feishu-code-block" data-language="..."><code>...</code></pre>` | `src/sources/feishu/extractor.js:401-425`, `src/sources/feishu/extractor.js:870-871` |
| 任务列表 | payload 命中 `todo/task/check_list` | `<label class="feishu-todo"><input type="checkbox" ... /><span>...</span></label>` | `src/sources/feishu/extractor.js:427-446`, `src/sources/feishu/extractor.js:872-873` |
| 分割线 | `divider/horizontal_rule/hr` | `<hr class="feishu-divider" />` | `src/sources/feishu/extractor.js:448-461`, `src/sources/feishu/extractor.js:864`, `src/sources/feishu/extractor.js:868-869` |
| 附件 | payload 命中 `file/attachment/drive_file` | `<p class="feishu-file">📎 + 文件名(链接)</p>` | `src/sources/feishu/extractor.js:463-485`, `src/sources/feishu/extractor.js:874-875` |
| 卡片/书签/多维表等 | payload 命中 `embed/sheet/bitable/mindnote/bookmark/link_preview` | `<p class="feishu-embed-link-wrap">...</p>` | `src/sources/feishu/extractor.js:487-506`, `src/sources/feishu/extractor.js:876-877` |
| 未知块（兜底） | 以上均不命中 | 尝试 `<p class="feishu-unknown"...>`，再不行输出 `<div class="feishu-unsupported"...>` | `src/sources/feishu/extractor.js:508-546`, `src/sources/feishu/extractor.js:897` |

## 2. 行内样式映射（文本内部）

| 飞书样式字段 | HTML 输出 | 代码位置 |
| --- | --- | --- |
| `inline_code` | `<code>...</code>` | `src/sources/feishu/extractor.js:212-214` |
| `bold` | `<strong>...</strong>` | `src/sources/feishu/extractor.js:215-217` |
| `italic` | `<em>...</em>` | `src/sources/feishu/extractor.js:218-220` |
| `underline` | `<u>...</u>` | `src/sources/feishu/extractor.js:221-223` |
| `strikethrough` | `<s>...</s>` | `src/sources/feishu/extractor.js:224-226` |
| `background_color` | `<mark data-feishu-bg-color="n">...</mark>` | `src/sources/feishu/extractor.js:227-230` |
| `text_color` | `<span class="feishu-text-color ..."...>...</span>` | `src/sources/feishu/extractor.js:232-238` |
| `link.url` | `<a href="..." target="_blank" rel="noopener noreferrer">...</a>` | `src/sources/feishu/extractor.js:240-243` |

## 3. 二次规范化（中间 HTML -> FoodTalks 粘贴 HTML）

| 中间结构 | FoodTalks 最终结构/规则 | 代码位置 |
| --- | --- | --- |
| `script/style/iframe/...` 和 `.feishu-unsupported` | 删除 | `src/app.js:999-1003` |
| `data-feishu-*` / 事件属性 | 删除 | `src/app.js:1004-1015` |
| `.feishu-grid` | 打平为顺序内容（移除并排列容器） | `src/app.js:1017-1025` |
| `a[href]` | URL 合法化；非法链接转纯文本 | `src/app.js:1027-1036`, `src/app.js:1138-1145` |
| `figure`（含 `feishu-image`） | 统一成 `<figure class="image"><img ...><figcaption ...></figure>` | `src/app.js:1038-1040`, `src/app.js:1203-1230` |
| 独立 `img` + 后续备注段落 | 自动合并为 `figure + figcaption`（最多3行） | `src/app.js:1042-1063`, `src/app.js:1248-1375` |
| `h1-h6` | 补 TOC 锚点 id（`mctoc_*`），默认 `text-align:justify` | `src/app.js:1074-1085` |
| `p/li/blockquote` | 默认 `text-align:justify`；引用补左边框样式 | `src/app.js:1087-1101` |
| `table` | 统一 `borderCollapse/width`；`th/td` 补边框、对齐、padding | `src/app.js:1104-1127` |

## 4. 你关心的“代码形式”示例

### 4.1 标题1

```html
<h1 style="text-align:left;">这是标题1</h1>
```

在粘贴阶段如果缺省，会补充锚点并规范：

```html
<h1 id="mctoc_这是标题1" style="text-align: justify;">这是标题1</h1>
```

### 4.2 表格

飞书渲染阶段：

```html
<div class="feishu-table-wrap">
  <table class="feishu-table" style="min-width:600px;width:600px;">
    <colgroup><col style="width:300px;" /><col style="width:300px;" /></colgroup>
    <tbody>
      <tr><th>表头1</th><th>表头2</th></tr>
      <tr><td>值1</td><td>值2</td></tr>
    </tbody>
  </table>
</div>
```

粘贴阶段会再补齐边框、对齐和内边距（如果缺失）：

```html
<table class="feishu-table table-cell-default-padding" style="border-collapse: collapse; width: 100%;">
  ...
  <td style="border: 1px solid #cccccc; text-align: left; vertical-align: middle; padding: 8px 10px;">值1</td>
</table>
```

### 4.3 图片 + 图片备注

```html
<figure class="image">
  <img src="..." width="600" style="max-width:100%;height:auto;display:block;margin-left:auto;margin-right:auto;" />
  <figcaption><span style="color:#7f7f7f;font-size:12px;">图片来源：小红书</span></figcaption>
</figure>
```

