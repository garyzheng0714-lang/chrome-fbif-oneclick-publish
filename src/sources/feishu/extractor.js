import { createFeishuClient } from './client.js';
import { applyHeadingSequenceRule } from './rules/index.js';

const TEXT_BLOCK_TYPE_TO_TAG = {
  2: 'p',
  3: 'h1',
  4: 'h2',
  5: 'h3',
  6: 'h4',
  7: 'h5',
  8: 'h6'
};

const LIST_BLOCK_TYPE_TO_TAG = {
  12: 'ul',
  13: 'ol'
};

const PASS_THROUGH_CONTAINER_TYPES = new Set([1]);
const CALLOUT_CONTAINER_TYPE = 19;
const GRID_BLOCK_TYPE = 24;
const GRID_COLUMN_BLOCK_TYPE = 25;
const IFRAME_BLOCK_TYPE = 26;
const IMAGE_BLOCK_TYPE = 27;
const TABLE_BLOCK_TYPE = 31;
const TABLE_CELL_BLOCK_TYPE = 32;
const QUOTE_CONTAINER_BLOCK_TYPE = 34;
const CALLOUT_EMOJI_MAP = {
  dart: '🎯',
  bulb: '💡',
  info: 'ℹ️',
  warning: '⚠️',
  check_mark: '✅',
  question: '❓',
  star: '⭐'
};
const ALIGN_VALUE_MAP = {
  1: 'left',
  2: 'center',
  3: 'right',
  4: 'justify'
};
const FEISHU_TEXT_COLOR_MAP = {
  1: '#cf2f2f',
  2: '#d9730d',
  3: '#a97b00',
  4: '#2f8a36',
  5: '#0b7d86',
  6: '#2a63c7',
  7: '#7a4cc2',
  8: '#5e6673'
};
const CAPTION_HINT_PATTERN = /(图片|图源|来源|供图|摄影|资料来源|photo|source)/i;
const META_BLOCK_KEYS = new Set(['block_id', 'block_type', 'parent_id', 'children']);

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) {
    return '';
  }

  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    decoded = text;
  }

  if (/^www\./i.test(decoded)) {
    decoded = `https://${decoded}`;
  }

  if (!/^(https?:|mailto:)/i.test(decoded)) {
    return '';
  }

  return decoded;
}

function formatCalloutEmoji(emojiId) {
  const normalized = normalizeText(emojiId);
  if (!normalized) {
    return '';
  }

  return CALLOUT_EMOJI_MAP[normalized] || `:${normalized}:`;
}

function getRichTextContainer(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  const keys = [
    'text',
    'heading1',
    'heading2',
    'heading3',
    'heading4',
    'heading5',
    'heading6',
    'heading7',
    'heading8',
    'heading9',
    'quote',
    'callout',
    'bullet',
    'ordered'
  ];

  for (const key of keys) {
    const container = block?.[key];
    const elements = container?.elements;
    if (Array.isArray(elements) && elements.length > 0) {
      return container;
    }
  }

  for (const key of keys) {
    const container = block?.[key];
    const elements = container?.elements;
    if (Array.isArray(elements)) {
      return container;
    }
  }

  return null;
}

function getRichTextElements(block) {
  const container = getRichTextContainer(block);
  if (Array.isArray(container?.elements)) {
    return container.elements;
  }

  return [];
}

function pickBlockPayloadByKeys(block, keys = []) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  for (const key of keys) {
    const payload = block[key];
    if (payload && typeof payload === 'object') {
      return payload;
    }
  }

  return null;
}

function pickBlockPayloadCandidates(block) {
  if (!block || typeof block !== 'object') {
    return [];
  }

  return Object.entries(block)
    .filter(([key, value]) => !META_BLOCK_KEYS.has(key) && value && typeof value === 'object')
    .map(([key, value]) => ({ key, value }));
}

function resolveAlignValue(rawAlign) {
  const align = Number(rawAlign || 0);
  return ALIGN_VALUE_MAP[align] || '';
}

function getBlockTextAlign(block) {
  if (!block || typeof block !== 'object') {
    return '';
  }

  if (Number(block.block_type) === IMAGE_BLOCK_TYPE) {
    return resolveAlignValue(block?.image?.align);
  }

  const container = getRichTextContainer(block);
  return resolveAlignValue(container?.style?.align);
}

function buildTextAlignAttr(align) {
  const normalized =
    typeof align === 'string'
      ? align.trim().toLowerCase()
      : '';
  const safeAlign =
    normalized && ['left', 'center', 'right', 'justify'].includes(normalized)
      ? normalized
      : resolveAlignValue(align);
  if (!safeAlign) {
    return '';
  }
  return ` style="text-align:${safeAlign};"`;
}

function applyInlineStyles(text, style = {}) {
  let result = escapeHtml(text).replace(/\n/g, '<br />');

  if (style.inline_code) {
    result = `<code>${result}</code>`;
  }
  if (style.bold) {
    result = `<strong>${result}</strong>`;
  }
  if (style.italic) {
    result = `<em>${result}</em>`;
  }
  if (style.underline) {
    result = `<u>${result}</u>`;
  }
  if (style.strikethrough) {
    result = `<s>${result}</s>`;
  }
  const bgColor = Number(style.background_color || 0);
  if (bgColor > 0) {
    result = `<mark data-feishu-bg-color="${bgColor}">${result}</mark>`;
  }

  const textColor = Number(style.text_color || 0);
  if (textColor > 0) {
    const mappedColor = FEISHU_TEXT_COLOR_MAP[textColor] || '';
    result = `<span class="feishu-text-color feishu-text-color-${textColor}"${
      mappedColor ? ` style="color:${mappedColor};"` : ''
    }>${result}</span>`;
  }

  const href = decodeUrl(style.link?.url || '');
  if (href) {
    result = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${result}</a>`;
  }

  return result;
}

function renderRichText(elements = []) {
  return elements
    .map((element) => {
      if (element?.text_run) {
        const run = element.text_run;
        return applyInlineStyles(run.content || '', run.text_element_style || {});
      }

      if (element?.mention_user?.name) {
        return escapeHtml(`@${element.mention_user.name}`);
      }

      if (element?.docs_link?.url) {
        const href = decodeUrl(element.docs_link.url);
        if (href) {
          return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>`;
        }
      }

      if (typeof element === 'string') {
        return escapeHtml(element);
      }

      return '';
    })
    .join('');
}

function extractPlainTextFromElements(elements = []) {
  return elements
    .map((element) => {
      if (element?.text_run?.content) {
        return String(element.text_run.content);
      }
      if (element?.mention_user?.name) {
        return `@${element.mention_user.name}`;
      }
      if (element?.docs_link?.url) {
        return decodeUrl(element.docs_link.url);
      }
      if (typeof element === 'string') {
        return element;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

function collectTextContent(context, text) {
  const normalized = normalizeText(text);
  if (normalized) {
    context.textChunks.push(normalized);
  }
}

function getCaptionTextFromBlock(block) {
  const elements = getRichTextElements(block);
  return normalizeText(extractPlainTextFromElements(elements));
}

function isLikelyImageCaptionBlock(block) {
  if (!block || Number(block?.block_type) !== 2) {
    return false;
  }

  const text = getCaptionTextFromBlock(block);
  if (!text) {
    return false;
  }

  const align = getBlockTextAlign(block);
  if (CAPTION_HINT_PATTERN.test(text) && text.length <= 96) {
    return true;
  }

  return align === 'center' && text.length <= 42;
}

function renderCaptionLineFromBlock(block, context) {
  const elements = getRichTextElements(block);
  const text = normalizeText(extractPlainTextFromElements(elements));
  if (text) {
    collectTextContent(context, text);
    context.paragraphCount += 1;
  }

  const html = renderRichText(elements).trim();
  const align = getBlockTextAlign(block);

  return {
    text,
    html,
    align
  };
}

function renderCaptionFromBlocks(blocks, context) {
  const safeBlocks = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (!safeBlocks.length) {
    return { text: '', html: '' };
  }

  const lines = safeBlocks
    .map((block) => renderCaptionLineFromBlock(block, context))
    .filter((item) => item.text || item.html);

  if (!lines.length) {
    return { text: '', html: '' };
  }

  const text = lines.map((item) => item.text).filter(Boolean).join('\n');
  const rootAlignAttr = buildTextAlignAttr(lines[0]?.align);

  if (lines.length === 1) {
    const content = lines[0].html || escapeHtml(lines[0].text || '');
    return {
      text,
      html: `<figcaption${rootAlignAttr}>${content}</figcaption>`
    };
  }

  const lineHtml = lines
    .map((line) => {
      const content = line.html || escapeHtml(line.text || '');
      const lineAlignAttr = buildTextAlignAttr(line.align || lines[0]?.align);
      return `<p${lineAlignAttr}>${content}</p>`;
    })
    .join('');

  return {
    text,
    html: `<figcaption${rootAlignAttr}>${lineHtml}</figcaption>`
  };
}

function renderCaptionFromBlock(block, context) {
  return renderCaptionFromBlocks(block ? [block] : [], context);
}

function renderImageBlock(block, context, { captionBlock = null, captionBlocks = null } = {}) {
  const token = normalizeText(block?.image?.token);
  if (!token) {
    return '';
  }

  const image = {
    index: context.images.length,
    src: '',
    alt: '',
    token,
    blockId: normalizeText(block?.block_id),
    caption: ''
  };

  const resolvedCaptionBlocks =
    Array.isArray(captionBlocks) && captionBlocks.length > 0
      ? captionBlocks
      : captionBlock
      ? [captionBlock]
      : [];
  const caption =
    resolvedCaptionBlocks.length > 0 ? renderCaptionFromBlocks(resolvedCaptionBlocks, context) : { text: '', html: '' };
  if (caption.text) {
    image.caption = caption.text;
  }

  context.images.push(image);
  context.paragraphCount += 1;
  const alignAttr = buildTextAlignAttr(getBlockTextAlign(block));

  return `<figure class="feishu-image"${alignAttr}><img data-feishu-token="${escapeHtml(
    token
  )}" data-feishu-block-id="${escapeHtml(image.blockId)}" alt="" />${caption.html || ''}</figure>`;
}

function extractPayloadElements(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  if (Array.isArray(payload.elements)) {
    return payload.elements;
  }

  if (Array.isArray(payload.content)) {
    return payload.content;
  }

  if (Array.isArray(payload?.text?.elements)) {
    return payload.text.elements;
  }

  return [];
}

function normalizeCodeLanguage(rawLanguage) {
  const lang = normalizeText(rawLanguage).toLowerCase();
  return lang || '';
}

function renderCodeBlock(block, context) {
  const payload = pickBlockPayloadByKeys(block, ['code', 'code_block', 'pre']);
  if (!payload) {
    return '';
  }

  const elements = extractPayloadElements(payload);
  let plainText = normalizeText(extractPlainTextFromElements(elements));

  if (!plainText) {
    plainText = normalizeText(payload?.text || payload?.content || '');
  }

  if (!plainText) {
    return '';
  }

  collectTextContent(context, plainText);
  context.paragraphCount += 1;

  const language = normalizeCodeLanguage(payload?.language || payload?.lang || payload?.style?.language);
  return `<pre class="feishu-code-block"${language ? ` data-language="${escapeHtml(language)}"` : ''}><code>${escapeHtml(
    plainText
  )}</code></pre>`;
}

function renderTodoBlock(block, context) {
  const payload = pickBlockPayloadByKeys(block, ['todo', 'task', 'check_list']);
  if (!payload) {
    return '';
  }

  const elements = extractPayloadElements(payload);
  const text = normalizeText(extractPlainTextFromElements(elements));
  const html = renderRichText(elements).trim() || escapeHtml(text || '');
  const checked = Boolean(payload?.checked || payload?.done || payload?.is_checked || payload?.is_completed);
  const alignAttr = buildTextAlignAttr(payload?.style?.align || getBlockTextAlign(block));

  if (text) {
    collectTextContent(context, text);
  }
  context.paragraphCount += 1;

  return `<label class="feishu-todo"${alignAttr}><input type="checkbox" disabled${checked ? ' checked' : ''} /><span>${html ||
    '<br />'}</span></label>`;
}

function renderDividerBlock(block, context = null) {
  if (!block || typeof block !== 'object') {
    return '';
  }

  if (block.divider || block.horizontal_rule || block.hr) {
    if (context) {
      context.paragraphCount += 1;
    }
    return '<hr class="feishu-divider" />';
  }

  return '';
}

function renderFileLikeBlock(block, context) {
  const payload = pickBlockPayloadByKeys(block, ['file', 'attachment', 'drive_file']);
  if (!payload) {
    return '';
  }

  const fileName = normalizeText(payload?.name || payload?.title || payload?.file_name || payload?.display_name);
  const fileToken = normalizeText(payload?.token || payload?.file_token || '');
  const fileUrl = decodeUrl(payload?.url || payload?.download_url || payload?.preview_url || '');
  const label = fileName || '附件';

  collectTextContent(context, label);
  context.paragraphCount += 1;

  const href = fileUrl || (fileToken ? `feishu://file/${encodeURIComponent(fileToken)}` : '');
  if (href) {
    return `<p class="feishu-file"><span class="feishu-file-icon">📎</span><a href="${escapeHtml(
      href
    )}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></p>`;
  }

  return `<p class="feishu-file"><span class="feishu-file-icon">📎</span><span>${escapeHtml(label)}</span></p>`;
}

function renderInlineCardLikeBlock(block, context) {
  const payload = pickBlockPayloadByKeys(block, ['embed', 'sheet', 'bitable', 'mindnote', 'bookmark', 'link_preview']);
  if (!payload) {
    return '';
  }

  const url = decodeUrl(payload?.url || payload?.link || payload?.preview_url || payload?.component?.url || '');
  const title = normalizeText(payload?.title || payload?.name || payload?.text || url || '卡片内容');

  collectTextContent(context, title);
  context.paragraphCount += 1;

  if (url) {
    return `<p class="feishu-embed-link-wrap"><a class="feishu-embed-link" href="${escapeHtml(
      url
    )}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></p>`;
  }

  return `<p class="feishu-embed-link-wrap">${escapeHtml(title)}</p>`;
}

function renderUnknownBlock(block, blocksMap, context, ancestry) {
  const children = Array.isArray(block?.children) ? block.children : [];
  if (children.length > 0) {
    return renderChildren(children, blocksMap, context, ancestry);
  }

  const payloads = pickBlockPayloadCandidates(block);
  for (const payloadItem of payloads) {
    const elements = extractPayloadElements(payloadItem.value);
    if (elements.length > 0) {
      const text = normalizeText(extractPlainTextFromElements(elements));
      if (text) {
        collectTextContent(context, text);
      }

      const html = renderRichText(elements).trim();
      if (html) {
        context.paragraphCount += 1;
        return `<p class="feishu-unknown" data-feishu-key="${escapeHtml(payloadItem.key)}">${html}</p>`;
      }
    }

    const url = decodeUrl(payloadItem.value?.url || payloadItem.value?.link || payloadItem.value?.component?.url || '');
    if (url) {
      collectTextContent(context, url);
      context.paragraphCount += 1;
      return `<p class="feishu-unknown" data-feishu-key="${escapeHtml(payloadItem.key)}"><a href="${escapeHtml(
        url
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></p>`;
    }
  }

  const type = Number(block?.block_type || 0);
  if (type > 0) {
    context.unsupportedBlockTypes.add(type);
  }

  return `<div class="feishu-unsupported" data-feishu-block-type="${escapeHtml(type || 'unknown')}"></div>`;
}

function renderTextBlock(block, context) {
  const elements = getRichTextElements(block);
  const plainText = extractPlainTextFromElements(elements);
  let html = renderRichText(elements).trim();
  if (!html) {
    return '';
  }

  const headingResult = applyHeadingSequenceRule({
    blockType: block?.block_type,
    plainText,
    renderedHtml: html,
    context
  });
  html = headingResult.html;
  collectTextContent(context, headingResult.plainText);

  context.paragraphCount += 1;
  const tag = TEXT_BLOCK_TYPE_TO_TAG[Number(block?.block_type)] || 'p';
  const alignAttr = buildTextAlignAttr(getBlockTextAlign(block));
  return `<${tag}${alignAttr}>${html}</${tag}>`;
}

function renderListItemBlock(block, blocksMap, context, ancestry) {
  const elements = getRichTextElements(block);
  collectTextContent(context, extractPlainTextFromElements(elements));

  const itemHtml = renderRichText(elements).trim();
  const children = Array.isArray(block?.children) ? block.children : [];
  const childrenHtml = children.length > 0 ? renderChildren(children, blocksMap, context, ancestry) : '';

  if (!itemHtml && !childrenHtml) {
    return '';
  }

  context.paragraphCount += 1;
  const alignAttr = buildTextAlignAttr(getBlockTextAlign(block));
  return `<li${alignAttr}>${[itemHtml, childrenHtml].filter(Boolean).join('\n')}</li>`;
}

function renderIframeBlock(block, context) {
  const url = decodeUrl(block?.iframe?.component?.url || '');
  if (!url) {
    return '';
  }

  collectTextContent(context, url);
  context.paragraphCount += 1;

  return `<p><a class="feishu-embed-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
    url
  )}</a></p>`;
}

function renderCalloutBlock(block, blocksMap, context, ancestry) {
  const children = Array.isArray(block?.children) ? block.children : [];
  const innerHtml = renderChildren(children, blocksMap, context, ancestry);
  if (!innerHtml) {
    return '';
  }

  const emoji = formatCalloutEmoji(block?.callout?.emoji_id);
  return `<aside class="feishu-callout"${emoji ? ` data-emoji="${escapeHtml(emoji)}"` : ''}>${innerHtml}</aside>`;
}

function renderQuoteContainerBlock(block, blocksMap, context, ancestry) {
  const children = Array.isArray(block?.children) ? block.children : [];
  const innerHtml = renderChildren(children, blocksMap, context, ancestry);
  if (!innerHtml) {
    return '';
  }

  return `<blockquote class="feishu-quote">${innerHtml}</blockquote>`;
}

function renderGridColumnBlock(blockId, blocksMap, context, ancestry) {
  const columnBlock = blocksMap.get(normalizeText(blockId));
  if (!columnBlock) {
    return '';
  }

  const children = Array.isArray(columnBlock.children) ? columnBlock.children : [];
  const innerHtml =
    Number(columnBlock.block_type) === GRID_COLUMN_BLOCK_TYPE
      ? renderChildren(children, blocksMap, context, ancestry)
      : renderBlock(blockId, blocksMap, context, ancestry);
  if (!innerHtml) {
    return '';
  }

  const ratio = Number(columnBlock?.grid_column?.width_ratio || 0);
  return `<div class="feishu-grid-col"${ratio > 0 ? ` style="--ratio:${ratio}"` : ''}>${innerHtml}</div>`;
}

function renderGridBlock(block, blocksMap, context, ancestry) {
  const children = Array.isArray(block?.children) ? block.children : [];
  if (!children.length) {
    return '';
  }

  const columnSize = Math.max(1, Number(block?.grid?.column_size || children.length || 1));
  const columnsHtml = children
    .map((childId) => renderGridColumnBlock(childId, blocksMap, context, ancestry))
    .filter(Boolean);

  if (!columnsHtml.length) {
    return '';
  }

  const ratios = children
    .map((childId) => Number(blocksMap.get(normalizeText(childId))?.grid_column?.width_ratio || 0))
    .map((ratio) => (Number.isFinite(ratio) && ratio > 0 ? ratio : 0));
  const hasRatioLayout = ratios.length === columnsHtml.length && ratios.some((ratio) => ratio > 0);
  const templateColumns = hasRatioLayout
    ? ratios.map((ratio) => `${Math.max(1, ratio)}fr`).join(' ')
    : `repeat(${columnSize},minmax(0,1fr))`;

  context.paragraphCount += 1;
  return `<div class="feishu-grid" style="grid-template-columns:${templateColumns};">${columnsHtml.join(
    '\n'
  )}</div>`;
}

function renderTableCellContent(cellId, blocksMap, context, ancestry) {
  const cellBlock = blocksMap.get(normalizeText(cellId));
  if (!cellBlock) {
    return '';
  }

  const children = Array.isArray(cellBlock.children) ? cellBlock.children : [];
  if (children.length > 0) {
    return renderChildren(children, blocksMap, context, ancestry);
  }

  if (getRichTextElements(cellBlock).length > 0) {
    return renderTextBlock(cellBlock, context);
  }

  return '';
}

function renderTableBlock(block, blocksMap, context, ancestry) {
  const table = block?.table || {};
  const property = table?.property || {};
  const cells = Array.isArray(table?.cells) && table.cells.length > 0
    ? table.cells
    : Array.isArray(block?.children)
      ? block.children
      : [];

  if (!cells.length) {
    return '';
  }

  let columnSize = Math.max(0, Number(property?.column_size || 0));
  let rowSize = Math.max(0, Number(property?.row_size || 0));

  if (!columnSize && rowSize) {
    columnSize = Math.ceil(cells.length / rowSize);
  }
  if (!rowSize && columnSize) {
    rowSize = Math.ceil(cells.length / columnSize);
  }
  if (!columnSize || !rowSize) {
    return renderChildren(cells, blocksMap, context, ancestry);
  }

  const mergeInfo = Array.isArray(property?.merge_info) ? property.merge_info : [];
  const covered = new Set();
  const rowsHtml = [];

  for (let rowIndex = 0; rowIndex < rowSize; rowIndex += 1) {
    const cellsHtml = [];

    for (let colIndex = 0; colIndex < columnSize; colIndex += 1) {
      const index = rowIndex * columnSize + colIndex;
      if (index >= cells.length) {
        continue;
      }

      const key = `${rowIndex}:${colIndex}`;
      if (covered.has(key)) {
        continue;
      }

      const merge = mergeInfo[index] || {};
      const rowSpan = Math.max(1, Math.min(rowSize - rowIndex, Number(merge.row_span || 1)));
      const colSpan = Math.max(1, Math.min(columnSize - colIndex, Number(merge.col_span || 1)));

      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        for (let c = colIndex; c < colIndex + colSpan; c += 1) {
          if (r === rowIndex && c === colIndex) {
            continue;
          }
          covered.add(`${r}:${c}`);
        }
      }

      const content = renderTableCellContent(cells[index], blocksMap, context, ancestry) || '<br />';
      const tag = rowIndex === 0 ? 'th' : 'td';
      const attrs = [
        rowSpan > 1 ? ` rowspan="${rowSpan}"` : '',
        colSpan > 1 ? ` colspan="${colSpan}"` : ''
      ].join('');

      cellsHtml.push(`<${tag}${attrs}>${content}</${tag}>`);
    }

    if (cellsHtml.length > 0) {
      rowsHtml.push(`<tr>${cellsHtml.join('')}</tr>`);
    }
  }

  if (!rowsHtml.length) {
    return '';
  }

  context.paragraphCount += Math.max(1, rowsHtml.length);

  const rawColumnWidth = Array.isArray(property?.column_width) ? property.column_width : [];
  const normalizedColumnRatios = normalizeTableColumnRatios(rawColumnWidth, columnSize);
  const colgroup = `<colgroup>${normalizedColumnRatios
    .map((ratio) => `<col style="width:${ratio}%;" />`)
    .join('')}</colgroup>`;

  return `<div class="feishu-table-wrap"><table class="feishu-table" style="width:100%;table-layout:fixed;">${colgroup}<tbody>${rowsHtml.join(
    ''
  )}</tbody></table></div>`;
}

function normalizeTableColumnRatios(rawWidths, columnSize) {
  const safeColumnSize = Math.max(1, Number(columnSize) || 1);
  const widths = Array.from({ length: safeColumnSize }, (_, index) => Number(rawWidths?.[index]) || 0);
  const positive = widths.filter((value) => value > 0);

  if (!positive.length) {
    const equal = Number((100 / safeColumnSize).toFixed(4));
    return new Array(safeColumnSize).fill(equal);
  }

  const max = Math.max(...positive);
  const scale = max > 2000 ? 20 : 1;
  const normalized = widths.map((value) => {
    if (value <= 0) {
      return 0;
    }
    const scaled = value / scale;
    return Math.min(520, Math.max(48, scaled));
  });

  const valid = normalized.filter((value) => value > 0);
  const fallback = valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 120;
  const filled = normalized.map((value) => (value > 0 ? value : fallback));
  const total = filled.reduce((sum, value) => sum + value, 0);

  if (!(total > 0)) {
    const equal = Number((100 / safeColumnSize).toFixed(4));
    return new Array(safeColumnSize).fill(equal);
  }

  return filled.map((value) => Number(((value / total) * 100).toFixed(4)));
}

function renderChildren(childIds, blocksMap, context, ancestry = new Set()) {
  if (!Array.isArray(childIds) || childIds.length === 0) {
    return '';
  }

  const chunks = [];
  let index = 0;

  while (index < childIds.length) {
    const childId = normalizeText(childIds[index]);
    if (!childId) {
      index += 1;
      continue;
    }

    const childBlock = blocksMap.get(childId);
    const childType = Number(childBlock?.block_type || 0);
    const listTag = LIST_BLOCK_TYPE_TO_TAG[childType];

    if (listTag) {
      const items = [];
      while (index < childIds.length) {
        const listId = normalizeText(childIds[index]);
        const listBlock = blocksMap.get(listId);
        const listType = Number(listBlock?.block_type || 0);
        if (listType !== childType) {
          break;
        }

        const listItemHtml = renderBlock(listId, blocksMap, context, ancestry);
        if (listItemHtml) {
          items.push(listItemHtml);
        }
        index += 1;
      }

      if (items.length > 0) {
        chunks.push(`<${listTag}>${items.join('\n')}</${listTag}>`);
      }

      continue;
    }

    if (childType === IMAGE_BLOCK_TYPE) {
      const captionBlocks = [];
      let cursor = index + 1;

      while (cursor < childIds.length && captionBlocks.length < 3) {
        const nextId = normalizeText(childIds[cursor]);
        if (!nextId) {
          break;
        }
        const nextBlock = blocksMap.get(nextId);
        if (!isLikelyImageCaptionBlock(nextBlock)) {
          break;
        }
        captionBlocks.push(nextBlock);
        cursor += 1;
      }

      if (captionBlocks.length > 0) {
        index = cursor - 1;
      }

      const imageHtml = renderImageBlock(childBlock, context, {
        captionBlock: captionBlocks[0] || null,
        captionBlocks
      });
      if (imageHtml) {
        chunks.push(imageHtml);
      }
      index += 1;
      continue;
    }

    const html = renderBlock(childId, blocksMap, context, ancestry);
    if (html) {
      chunks.push(html);
    }
    index += 1;
  }

  return chunks.join('\n');
}

function renderBlock(blockId, blocksMap, context, ancestry = new Set()) {
  const normalizedId = normalizeText(blockId);
  if (!normalizedId) {
    return '';
  }

  if (ancestry.has(normalizedId)) {
    return '';
  }

  const block = blocksMap.get(normalizedId);
  if (!block) {
    return '';
  }

  ancestry.add(normalizedId);
  const type = Number(block.block_type || 0);

  let selfHtml = '';
  const children = Array.isArray(block.children) ? block.children : [];
  const dividerHtml = renderDividerBlock(block, context);

  if (type === IMAGE_BLOCK_TYPE) {
    selfHtml = renderImageBlock(block, context);
  } else if (dividerHtml) {
    selfHtml = dividerHtml;
  } else if (pickBlockPayloadByKeys(block, ['code', 'code_block', 'pre'])) {
    selfHtml = renderCodeBlock(block, context);
  } else if (pickBlockPayloadByKeys(block, ['todo', 'task', 'check_list'])) {
    selfHtml = renderTodoBlock(block, context);
  } else if (pickBlockPayloadByKeys(block, ['file', 'attachment', 'drive_file'])) {
    selfHtml = renderFileLikeBlock(block, context);
  } else if (pickBlockPayloadByKeys(block, ['embed', 'sheet', 'bitable', 'mindnote', 'bookmark', 'link_preview'])) {
    selfHtml = renderInlineCardLikeBlock(block, context);
  } else if (type === GRID_BLOCK_TYPE) {
    selfHtml = renderGridBlock(block, blocksMap, context, ancestry);
  } else if (type === TABLE_BLOCK_TYPE) {
    selfHtml = renderTableBlock(block, blocksMap, context, ancestry);
  } else if (type === TABLE_CELL_BLOCK_TYPE) {
    selfHtml = renderChildren(children, blocksMap, context, ancestry);
  } else if (type === CALLOUT_CONTAINER_TYPE) {
    selfHtml = renderCalloutBlock(block, blocksMap, context, ancestry);
  } else if (type === QUOTE_CONTAINER_BLOCK_TYPE) {
    selfHtml = renderQuoteContainerBlock(block, blocksMap, context, ancestry);
  } else if (type === IFRAME_BLOCK_TYPE) {
    selfHtml = renderIframeBlock(block, context);
  } else if (LIST_BLOCK_TYPE_TO_TAG[type]) {
    selfHtml = renderListItemBlock(block, blocksMap, context, ancestry);
  } else if (TEXT_BLOCK_TYPE_TO_TAG[type] || getRichTextElements(block).length > 0) {
    selfHtml = renderTextBlock(block, context);
  } else if (PASS_THROUGH_CONTAINER_TYPES.has(type) || children.length > 0) {
    selfHtml = renderChildren(children, blocksMap, context, ancestry);
  } else {
    selfHtml = renderUnknownBlock(block, blocksMap, context, ancestry);
  }

  ancestry.delete(normalizedId);
  return selfHtml;
}

function isSupportedFeishuHost(hostname) {
  return /^([a-z0-9-]+\.)?(feishu\.cn|larkoffice\.com)$/i.test(String(hostname || '').trim());
}

export function parseFeishuDocToken(url) {
  const normalized = String(url || '').trim();
  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    const match = parsed.pathname.match(/^\/(?:docx|wiki)\/([a-z0-9]+)/i);
    return match?.[1] || '';
  } catch {
    const match = normalized.match(/\/(?:docx|wiki)\/([a-z0-9]+)/i);
    return match?.[1] || '';
  }
}

export function isFeishuDocUrl(url) {
  const normalized = String(url || '').trim();
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return false;
    }
    if (!isSupportedFeishuHost(parsed.hostname)) {
      return false;
    }
    return Boolean(parseFeishuDocToken(normalized));
  } catch {
    return false;
  }
}

export async function extractFeishuDocByApi({ url, appId, appSecret, fetchImpl = fetch }) {
  if (!isFeishuDocUrl(url)) {
    throw new Error('不是有效的飞书文档链接（支持 /docx/ 或 /wiki/）');
  }

  const docToken = parseFeishuDocToken(url);
  if (!docToken) {
    throw new Error('未识别到飞书文档 token');
  }

  const client = createFeishuClient({
    appId,
    appSecret,
    fetchImpl
  });

  const [documentData, blocks] = await Promise.all([client.getDocument(docToken), client.listDocumentBlocks(docToken)]);
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('飞书文档 blocks 为空');
  }

  const blocksMap = new Map(blocks.map((block) => [normalizeText(block.block_id), block]));
  const root = blocksMap.get(docToken) || blocks.find((item) => Number(item.block_type) === 1) || null;

  const rootChildren = Array.isArray(root?.children) && root.children.length > 0 ? root.children : [docToken];
  const context = {
    images: [],
    textChunks: [],
    paragraphCount: 0,
    unsupportedBlockTypes: new Set(),
    headingCounters: [0, 0, 0, 0, 0, 0]
  };

  const contentHtml = renderChildren(rootChildren, blocksMap, context).trim();

  if (!contentHtml) {
    throw new Error('飞书文档正文渲染为空');
  }

  const textPlain = context.textChunks.join('\n').trim();
  const title = normalizeText(documentData?.document?.title) || normalizeText(documentData?.title) || '未命名文档';
  const coverToken = context.images[0]?.token || '';

  const validationHints = [];
  if (!coverToken) {
    validationHints.push('未识别到封面图');
  }
  if (context.paragraphCount < 1) {
    validationHints.push('段落数量为 0，建议检查文档权限');
  }
  if (context.unsupportedBlockTypes.size > 0) {
    validationHints.push(`检测到未完全适配的块类型：${[...context.unsupportedBlockTypes].sort((a, b) => a - b).join(', ')}`);
  }

  return {
    sourceType: 'feishu-api',
    sourceUrl: String(url || '').trim(),
    title,
    coverUrl: '',
    coverToken,
    contentHtml,
    textPlain,
    wordCount: textPlain.replace(/\s+/g, '').length,
    paragraphCount: context.paragraphCount,
    imageCount: context.images.length,
    images: context.images,
    validationHints,
    feishu: {
      docToken,
      blockCount: blocks.length
    }
  };
}

export async function downloadFeishuImageAsDataUrl({
  mediaToken,
  appId,
  appSecret,
  fetchImpl = fetch
}) {
  const token = normalizeText(mediaToken);
  if (!token) {
    throw new Error('缺少媒体 token');
  }

  const client = createFeishuClient({
    appId,
    appSecret,
    fetchImpl
  });

  return client.downloadMediaAsDataUrl(token);
}
