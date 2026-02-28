const DEFAULT_MAX_CHUNK_LENGTH = 12_000;
const DEFAULT_IMAGE_DELAY_MS = 8;
const DEFAULT_DATA_IMAGE_DELAY_MS = 80;
const DEFAULT_TEXT_YIELD_EVERY = 4;
const SPLIT_LOOKAHEAD_PATTERN =
  /(?=<(?:figure|img|p|h[1-6]|blockquote|ul|ol|li|pre|code|table|section|article|div)\b)/gi;
const SEMANTIC_TAG_PATTERN = /<(img|p|h[1-6]|li|blockquote|pre|code)\b/gi;

function toPositiveNumber(value, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) {
    return fallback;
  }
  return next;
}

function hasImageTag(html) {
  return /<img\b/i.test(String(html || ''));
}

function isDataImageTag(html) {
  return /<img\b[^>]*\ssrc\s*=\s*['"]data:image\//i.test(String(html || ''));
}

function splitLongTokenInOrder(token, maxChunkLength) {
  const chunks = [];
  let cursor = 0;
  const normalized = String(token || '');
  while (cursor < normalized.length) {
    chunks.push(normalized.slice(cursor, cursor + maxChunkLength));
    cursor += maxChunkLength;
  }
  return chunks;
}

// 参考策略：
// 1) mp-html 解析器用 stack + sibling push 保证节点顺序（https://github.com/jin-yufeng/mp-html）
// 2) wxParse 的 html2json 在 start/end 回调中按 parent.nodes.push 保序（https://github.com/icindy/wxParse）
// 3) wechat-format 的 marked renderer 按 token 线性渲染 image/paragraph（https://github.com/lyricat/wechat-format）
// 本模块沿用“线性顺序优先”原则：任何分片优化都不能改变源 HTML 的节点顺序。
export function splitWechatHtmlIntoOrderedChunks(rawHtml, options = {}) {
  const sourceHtml = String(rawHtml || '').trim();
  if (!sourceHtml) {
    return [];
  }

  const maxChunkLength = toPositiveNumber(options.maxChunkLength, DEFAULT_MAX_CHUNK_LENGTH);
  const rawTokens = sourceHtml
    .split(SPLIT_LOOKAHEAD_PATTERN)
    .map((token) => String(token || '').trim())
    .filter(Boolean);
  const tokens = rawTokens.length > 0 ? rawTokens : [sourceHtml];

  const chunks = [];
  let current = '';
  let currentHasImage = false;

  const flushCurrent = () => {
    if (!current) {
      return;
    }
    chunks.push(current);
    current = '';
    currentHasImage = false;
  };

  tokens.forEach((token) => {
    const tokenHasImage = hasImageTag(token);
    const tokenList =
      token.length > maxChunkLength ? splitLongTokenInOrder(token, maxChunkLength) : [token];

    tokenList.forEach((piece) => {
      const pieceHasImage = hasImageTag(piece);
      if ((pieceHasImage && current) || (!pieceHasImage && currentHasImage)) {
        flushCurrent();
      }

      if (!current) {
        current = piece;
        currentHasImage = pieceHasImage;
        return;
      }

      if (current.length + piece.length > maxChunkLength) {
        flushCurrent();
        current = piece;
        currentHasImage = pieceHasImage;
      } else {
        current += piece;
        currentHasImage = currentHasImage || pieceHasImage;
      }
    });
  });

  flushCurrent();
  return chunks;
}

export function buildWechatEditorInsertPlan(rawHtml, options = {}) {
  const maxChunkLength = toPositiveNumber(options.maxChunkLength, DEFAULT_MAX_CHUNK_LENGTH);
  const imageDelayMs = Math.max(0, Number(options.imageDelayMs ?? DEFAULT_IMAGE_DELAY_MS));
  const dataImageDelayMs = Math.max(0, Number(options.dataImageDelayMs ?? DEFAULT_DATA_IMAGE_DELAY_MS));
  const textYieldEvery = Math.max(1, Number(options.textYieldEvery) || DEFAULT_TEXT_YIELD_EVERY);
  const chunks = splitWechatHtmlIntoOrderedChunks(rawHtml, { maxChunkLength });

  return chunks.map((chunk, index) => {
    const isImageChunk = hasImageTag(chunk);
    const isDataImageChunk = isDataImageTag(chunk);
    return {
      index,
      html: chunk,
      isImage: isImageChunk,
      isDataImage: isDataImageChunk,
      delayMs: isImageChunk ? (isDataImageChunk ? dataImageDelayMs : imageDelayMs) : 0,
      yieldAfter: isImageChunk ? true : (index + 1) % textYieldEvery === 0
    };
  });
}

export function buildImageTextRunSignature(rawHtml, options = {}) {
  const sourceHtml = String(rawHtml || '').trim();
  if (!sourceHtml) {
    return '';
  }

  const maxTokens = Math.max(10, Number(options.maxTokens) || 320);
  const signature = [];
  let match = null;
  while ((match = SEMANTIC_TAG_PATTERN.exec(sourceHtml)) && signature.length < maxTokens) {
    const marker = String(match[1] || '').toLowerCase() === 'img' ? 'I' : 'T';
    if (signature[signature.length - 1] !== marker) {
      signature.push(marker);
    }
  }
  return signature.join('');
}

export function isImageTextRunCompatible(expectedSignature, actualSignature) {
  const expected = String(expectedSignature || '').trim();
  const actual = String(actualSignature || '').trim();
  if (!expected || !expected.includes('I')) {
    return true;
  }
  if (!actual || !actual.includes('I')) {
    return false;
  }
  if (expected === actual) {
    return true;
  }

  let cursor = 0;
  for (let index = 0; index < actual.length && cursor < expected.length; index += 1) {
    if (expected[cursor] === actual[index]) {
      cursor += 1;
    }
  }
  return cursor === expected.length;
}
