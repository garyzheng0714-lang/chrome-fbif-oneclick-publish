const dom = {
  urlInput: document.getElementById('urlInput'),
  feishuAppIdInput: document.getElementById('feishuAppIdInput'),
  feishuAppSecretInput: document.getElementById('feishuAppSecretInput'),
  extractButton: document.getElementById('extractButton'),
  copyButton: document.getElementById('copyButton'),
  statusText: document.getElementById('statusText'),
  metaText: document.getElementById('metaText')
};

const IMAGE_FETCH_CONCURRENCY = 1;
const IMAGE_FETCH_MAX_ATTEMPTS = 0;
const IMAGE_FETCH_RETRY_BASE_DELAY_MS = 800;
const IMAGE_FETCH_RETRY_MAX_DELAY_MS = 10_000;
const state = {
  pendingHtml: '',
  copied: false
};

bootstrap().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), 'error');
});

async function bootstrap() {
  dom.extractButton?.addEventListener('click', onExtract);
  dom.copyButton?.addEventListener('click', onCopy);
  setExtractBusy(false);
  resetCopyState();
  setStatus('正在读取当前页面链接...', 'info');

  const [activeUrl, settingsResponse] = await Promise.all([getActiveTabUrl(), runtimeSend({ type: 'GET_SOURCE_SETTINGS' })]);

  if (settingsResponse.ok) {
    dom.feishuAppIdInput.value = settingsResponse.settings?.feishuAppId || '';
    dom.feishuAppSecretInput.value = settingsResponse.settings?.feishuAppSecret || '';
  }

  if (activeUrl) {
    dom.urlInput.value = activeUrl;
  }

  const currentUrl = dom.urlInput.value.trim();
  if (isFeishuDocUrl(currentUrl)) {
    setStatus('已自动识别当前飞书文档，点击按钮即可提取', 'success');
  } else {
    setStatus('当前页不是飞书文档链接，请手动粘贴 /docx/ 或 /wiki/ 链接', 'info');
  }
}

async function onExtract() {
  setExtractBusy(true);
  resetCopyState();
  dom.metaText.textContent = '-';

  try {
    const url = dom.urlInput.value.trim();
    if (!url) {
      throw new Error('请先输入飞书文档链接（/docx/ 或 /wiki/）');
    }
    if (!isFeishuDocUrl(url)) {
      throw new Error('仅支持飞书文档链接（/docx/... 或 /wiki/...）');
    }

    const sourceSettings = collectSourceSettings();
    await saveSourceSettings(sourceSettings);

    setStatus('正在提取文档内容...', 'info');
    const extractResponse = await runtimeSend({
      type: 'EXTRACT_ARTICLE',
      payload: {
        url,
        forceRefresh: true,
        manualSelector: '',
        followTabs: false,
        sourceSettings
      }
    });

    if (!extractResponse.ok) {
      throw new Error(formatExtractError(extractResponse.error || '提取失败'));
    }

    let contentHtml = String(extractResponse.data?.contentHtml || '').trim();
    if (!contentHtml) {
      throw new Error('提取结果为空，请确认文档内容与权限');
    }

    setStatus('正在拉取图片并生成最终代码...', 'info');
    const hydration = await hydrateFeishuHtmlAssets(contentHtml, sourceSettings);
    contentHtml = hydration.html;
    if (hydration.failedTokens.length > 0) {
      throw new Error(
        `有 ${hydration.failedTokens.length} 张图片下载失败，已停止复制。请重试提取（网络稳定后再试）。`
      );
    }

    const finalHtml = buildFoodtalksPasteHtml(contentHtml);
    if (!finalHtml) {
      throw new Error('代码生成为空，请重试');
    }

    const imageCheck = validatePublishHtmlImages(finalHtml);
    if (imageCheck.invalidCount > 0) {
      throw new Error(
        `有 ${imageCheck.invalidCount} 张图片未就绪（缺少 src 或仍为 blob 地址），已停止复制。请重试提取。`
      );
    }

    state.pendingHtml = finalHtml;
    state.copied = false;
    setCopyButtonState({ enabled: true, copied: false });
    setStatus('提取成功，请点击“复制代码”按钮', 'success');
    dom.metaText.textContent = `标题：${extractResponse.data?.title || '-'} | 字数：${extractResponse.data?.wordCount || 0} | 图片：${
      extractResponse.data?.imageCount || 0
    }`;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    setExtractBusy(false);
  }
}

async function onCopy() {
  try {
    if (!state.pendingHtml) {
      throw new Error('请先提取内容，再点击复制');
    }

    await copyTextToClipboard(state.pendingHtml);
    state.copied = true;
    setCopyButtonState({ enabled: false, copied: true });
    setStatus('代码已复制，可前往 FoodTalks 后台粘贴', 'success');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

function setExtractBusy(busy) {
  if (dom.extractButton) {
    dom.extractButton.disabled = busy;
    dom.extractButton.textContent = busy ? '提取中...' : '提取内容';
  }

  if (busy) {
    setCopyButtonState({ enabled: false, copied: state.copied });
    return;
  }

  setCopyButtonState({ enabled: Boolean(state.pendingHtml) && !state.copied, copied: state.copied });
}

function setCopyButtonState({ enabled, copied }) {
  if (!dom.copyButton) {
    return;
  }

  dom.copyButton.disabled = !enabled;
  dom.copyButton.classList.toggle('is-copied', Boolean(copied));
  if (copied) {
    dom.copyButton.textContent = '已复制';
    return;
  }
  dom.copyButton.textContent = enabled ? '复制代码' : '等待提取';
}

function resetCopyState() {
  state.pendingHtml = '';
  state.copied = false;
  setCopyButtonState({ enabled: false, copied: false });
}

function setStatus(message, tone = 'info') {
  if (!dom.statusText) {
    return;
  }
  dom.statusText.textContent = String(message || '');
  dom.statusText.dataset.tone = tone;
}

function collectSourceSettings() {
  return {
    feishuAppId: dom.feishuAppIdInput.value.trim(),
    feishuAppSecret: dom.feishuAppSecretInput.value.trim()
  };
}

async function saveSourceSettings(settings) {
  const response = await runtimeSend({
    type: 'SAVE_SOURCE_SETTINGS',
    payload: settings
  });

  if (!response.ok) {
    throw new Error(response.error || '保存飞书凭据失败');
  }
}

function formatExtractError(rawMessage) {
  const message = String(rawMessage || '').trim();
  if (!message) {
    return '提取失败，请稍后重试';
  }

  if (
    /读取失败：请先在该飞书文档中添加应用/.test(message) ||
    /(forbidden|permission|权限|无权限|未授权|not authorized|code=177003|code=91403|code=99991663)/i.test(message)
  ) {
    return '无法读取文档：请先把应用（机器人）添加到该飞书文档并授予权限，然后重新提取';
  }

  return message;
}

async function getActiveTabUrl() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return String(tabs?.[0]?.url || '').trim();
}

function isFeishuDocUrl(url) {
  return /^https?:\/\/([a-z0-9-]+\.)?(feishu\.cn|larkoffice\.com)\/(?:docx|wiki)\/[a-z0-9]+/i.test(
    String(url || '').trim()
  );
}

async function runtimeSend(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function hydrateFeishuHtmlAssets(contentHtml, sourceSettings) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = contentHtml || '';
  const tokenNodeMap = new Map();
  const failedTokens = [];

  const nodes = [...wrapper.querySelectorAll('img[data-feishu-token]')];
  nodes.forEach((node) => {
    const token = node.getAttribute('data-feishu-token') || '';
    if (!token) {
      return;
    }
    if (!tokenNodeMap.has(token)) {
      tokenNodeMap.set(token, []);
    }
    tokenNodeMap.get(token).push(node);
  });

  const tokens = [...tokenNodeMap.keys()];
  if (!tokens.length) {
    return {
      html: wrapper.innerHTML.trim(),
      failedTokens
    };
  }

  let processedImageCount = 0;
  await runWithConcurrency(tokens, IMAGE_FETCH_CONCURRENCY, async (token) => {
    processedImageCount += 1;
    setStatus(`正在下载图片 ${processedImageCount}/${tokens.length}（失败自动重试，原图保留）`, 'info');
    const response = await fetchFeishuImageWithRetry(token, sourceSettings, IMAGE_FETCH_MAX_ATTEMPTS);

    const relatedNodes = tokenNodeMap.get(token) || [];
    if (!response.ok || !response.dataUrl) {
      failedTokens.push(token);
      relatedNodes.forEach((node) => {
        node.setAttribute('alt', '图片加载失败');
        node.removeAttribute('src');
      });
      return;
    }

    relatedNodes.forEach((node) => {
      node.setAttribute('src', response.dataUrl);
      node.removeAttribute('data-feishu-token');
      node.removeAttribute('data-feishu-block-id');
    });
  });

  return {
    html: wrapper.innerHTML.trim(),
    failedTokens
  };
}

async function fetchFeishuImageWithRetry(token, sourceSettings, maxAttempts = IMAGE_FETCH_MAX_ATTEMPTS) {
  let lastResponse = { ok: false, error: '图片下载失败' };
  const attemptsValue = Number(maxAttempts);
  const unlimitedRetry = !Number.isFinite(attemptsValue) || attemptsValue <= 0;
  const attempts = unlimitedRetry ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(attemptsValue));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await runtimeSend({
      type: 'FETCH_FEISHU_IMAGE',
      payload: {
        mediaToken: token,
        sourceSettings
      }
    });

    if (response.ok && response.dataUrl) {
      return response;
    }

    lastResponse = response;
    if (isNonRetryableImageFetchError(response?.error || '')) {
      return response;
    }

    if (attempt < attempts || unlimitedRetry) {
      const delayMs = Math.min(IMAGE_FETCH_RETRY_BASE_DELAY_MS * attempt, IMAGE_FETCH_RETRY_MAX_DELAY_MS);
      await delay(delayMs);
    }
  }

  return lastResponse;
}

function isNonRetryableImageFetchError(rawError) {
  const message = String(rawError || '').toLowerCase();
  if (!message) {
    return false;
  }

  return /(缺少飞书 app 凭据|缺少飞书图片 token|permission|forbidden|unauthorized|无权限|未授权|401|403|177003|91403|99991663)/i.test(
    message
  );
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const size = Math.max(1, Number(limit) || 1);
  const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (typeof item === 'undefined') {
        return;
      }
      await worker(item);
    }
  });

  await Promise.all(runners);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildFoodtalksPasteHtml(rawHtml) {
  const sourceHtml = String(rawHtml || '').trim();
  if (!sourceHtml) {
    return '';
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${sourceHtml}</body>`, 'text/html');
  const body = doc.body;
  if (!body) {
    return sourceHtml;
  }

  body.querySelectorAll('script,style,iframe,meta,link,noscript,form,input,textarea,button').forEach((node) => {
    node.remove();
  });
  body.querySelectorAll('.feishu-unsupported').forEach((node) => node.remove());

  body.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = String(attribute.name || '').toLowerCase();
      if (name.startsWith('on') || name === 'contenteditable') {
        node.removeAttribute(attribute.name);
        return;
      }
      if (name.startsWith('data-feishu-')) {
        node.removeAttribute(attribute.name);
      }
    });
  });

  body.querySelectorAll('.feishu-grid').forEach((grid) => {
    const fragment = doc.createDocumentFragment();
    [...grid.querySelectorAll('.feishu-grid-col')].forEach((column) => {
      while (column.firstChild) {
        fragment.appendChild(column.firstChild);
      }
    });
    grid.replaceWith(fragment);
  });

  body.querySelectorAll('a[href]').forEach((anchor) => {
    const href = normalizeUrlForPublish(anchor.getAttribute('href') || '');
    if (!href) {
      anchor.replaceWith(doc.createTextNode(normalizeText(anchor.textContent || '')));
      return;
    }
    anchor.setAttribute('href', href);
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener');
  });

  body.querySelectorAll('figure').forEach((figure) => {
    normalizeFigureNodeForPublish(figure, doc);
  });

  const standaloneImages = [...body.querySelectorAll('img')].filter((img) => !img.closest('figure'));
  standaloneImages.forEach((img) => {
    normalizeImageNodeForPublish(img);
    if (img.closest('td,th,li')) {
      return;
    }

    const parentParagraph = img.parentElement instanceof HTMLParagraphElement ? img.parentElement : null;
    const wrapsOnlyImage =
      Boolean(parentParagraph) &&
      parentParagraph.querySelectorAll('img').length === 1 &&
      normalizeText(parentParagraph.textContent || '') === '';
    const sourceNode = wrapsOnlyImage ? parentParagraph : img;
    const captionLines = collectFollowingCaptionLines(sourceNode);

    if (captionLines.length > 0) {
      const figure = doc.createElement('figure');
      figure.className = 'image';
      sourceNode.replaceWith(figure);
      figure.appendChild(img);
      appendCaptionLinesToFigure(figure, captionLines, doc);
      return;
    }

    if (!img.closest('p')) {
      const paragraph = doc.createElement('p');
      paragraph.style.textAlign = 'center';
      img.replaceWith(paragraph);
      paragraph.appendChild(img);
    }
  });

  body.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading, index) => {
    if (!normalizeText(heading.id)) {
      const idBase = normalizeText(heading.textContent)
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
        .replace(/^_+|_+$/g, '');
      heading.id = `mctoc_${idBase || index + 1}`;
    }
    if (!heading.style.textAlign) {
      heading.style.textAlign = 'justify';
    }
  });

  body.querySelectorAll('p,li,blockquote').forEach((node) => {
    const text = normalizeText(node.textContent || '');
    const hasOnlyBreak = node.childNodes.length === 1 && node.firstChild?.nodeName === 'BR';
    if (!text && !hasOnlyBreak) {
      return;
    }

    if (!node.style.textAlign) {
      node.style.textAlign = 'justify';
    }
    if (node.tagName === 'BLOCKQUOTE') {
      node.style.borderLeft = '3px solid #c9d3e4';
      node.style.paddingLeft = '12px';
      node.style.margin = '12px 0';
    }
  });

  body.querySelectorAll('table').forEach((table) => {
    table.style.borderCollapse = 'collapse';
    table.style.width = table.style.width || '100%';
    if (![...table.classList].some((name) => name.startsWith('table-cell-'))) {
      table.classList.add('table-cell-default-padding');
    }

    table.querySelectorAll('th,td').forEach((cell) => {
      if (!cell.style.border) {
        cell.style.border = '1px solid #cccccc';
      }
      if (!cell.style.textAlign) {
        const align = normalizeText(cell.getAttribute('align') || '').toLowerCase();
        cell.style.textAlign = align && ['left', 'center', 'right', 'justify'].includes(align) ? align : 'left';
      }
      if (!cell.style.verticalAlign) {
        const valign = normalizeText(cell.getAttribute('valign') || '').toLowerCase();
        cell.style.verticalAlign = valign && ['top', 'middle', 'bottom'].includes(valign) ? valign : 'middle';
      }
      if (!cell.style.padding) {
        cell.style.padding = '8px 10px';
      }
    });
  });

  body.querySelectorAll('section').forEach((section) => {
    if (!normalizeText(section.textContent) && section.querySelectorAll('img,table,video,audio').length === 0) {
      section.remove();
    }
  });

  return body.innerHTML.trim();
}

function normalizeUrlForPublish(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return `https:${raw}`;
  if (/^https?:/i.test(raw)) return raw;
  return '';
}

function resolveTextAlignForPublish(...nodes) {
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    const styleAlign = normalizeText(node.style.textAlign || '').toLowerCase();
    if (styleAlign && ['left', 'center', 'right', 'justify'].includes(styleAlign)) {
      return styleAlign;
    }
    const attrAlign = normalizeText(node.getAttribute('align') || '').toLowerCase();
    if (attrAlign && ['left', 'center', 'right', 'justify'].includes(attrAlign)) {
      return attrAlign;
    }
  }
  return '';
}

function normalizeImageNodeForPublish(img, contextNode = null) {
  if (!(img instanceof HTMLImageElement)) {
    return;
  }

  const src = normalizeUrlForPublish(
    img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || ''
  );
  if (src) {
    img.setAttribute('src', src);
  } else {
    img.removeAttribute('src');
  }

  const align = resolveTextAlignForPublish(contextNode, img);
  img.style.display = 'block';
  img.style.height = 'auto';
  img.style.maxWidth = '100%';

  if (align === 'left') {
    img.style.marginLeft = '0';
    img.style.marginRight = 'auto';
  } else if (align === 'right') {
    img.style.marginLeft = 'auto';
    img.style.marginRight = '0';
  } else {
    img.style.marginLeft = 'auto';
    img.style.marginRight = 'auto';
  }

  const widthAttr = Number(img.getAttribute('width') || 0);
  if (!widthAttr || widthAttr > 680) {
    img.setAttribute('width', '600');
  }

  img.removeAttribute('loading');
  img.removeAttribute('decoding');
  img.removeAttribute('data-feishu-token');
  img.removeAttribute('data-feishu-block-id');
}

function validatePublishHtmlImages(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${String(html || '')}</body>`, 'text/html');
  const images = [...doc.body.querySelectorAll('img')];

  let invalidCount = 0;
  images.forEach((img) => {
    const src = String(img.getAttribute('src') || '').trim();
    if (!src || /^blob:/i.test(src)) {
      invalidCount += 1;
    }
  });

  return {
    totalCount: images.length,
    invalidCount
  };
}

function normalizeFigureNodeForPublish(figure, doc) {
  if (!(figure instanceof HTMLElement)) {
    return;
  }

  const img = figure.querySelector('img');
  if (!(img instanceof HTMLImageElement)) {
    return;
  }

  normalizeImageNodeForPublish(img, figure);
  const captionLines = [];
  const figcaption = figure.querySelector('figcaption');
  if (figcaption) {
    captionLines.push(...extractCaptionLines(figcaption));
    figcaption.remove();
  }
  captionLines.push(...collectFollowingCaptionLines(figure));

  while (figure.firstChild) {
    figure.removeChild(figure.firstChild);
  }

  figure.className = 'image';
  figure.removeAttribute('style');
  figure.appendChild(img);
  appendCaptionLinesToFigure(figure, captionLines, doc);
}

function extractCaptionLines(container) {
  if (!(container instanceof HTMLElement)) {
    return [];
  }

  const lines = [...container.querySelectorAll('p')]
    .map((node) => normalizeText(node.textContent || ''))
    .filter(Boolean);
  if (lines.length > 0) {
    return lines.slice(0, 3);
  }

  const fallback = normalizeText(container.textContent || '');
  return fallback ? [fallback] : [];
}

function collectFollowingCaptionLines(anchorNode) {
  const lines = [];
  let cursor = anchorNode?.nextElementSibling || null;

  while (cursor && lines.length < 3) {
    if (!(cursor instanceof HTMLParagraphElement)) {
      break;
    }

    const allowLoose =
      lines.length === 0 &&
      isLooseCaptionLeadParagraph(cursor) &&
      !isExcludedCaptionLeadText(normalizeText(cursor.textContent || ''));

    if (!isLikelyCaptionParagraph(cursor, { allowLoose })) {
      break;
    }

    const line = normalizeText(cursor.textContent || '');
    if (line) {
      lines.push(line);
    }

    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }

  return lines;
}

function isLikelyCaptionParagraph(node, options = {}) {
  if (!(node instanceof HTMLParagraphElement)) {
    return false;
  }

  const text = normalizeText(node.textContent || '');
  if (!text || text.length > 90) {
    return false;
  }

  if (isExcludedCaptionLeadText(text)) {
    return false;
  }

  const isSourceLine = isSourceCaptionLine(text);
  if (!isSourceLine && looksLikeBodySentence(text)) {
    return false;
  }

  const align = resolveTextAlignForPublish(node);
  const hasShortCaptionLabel = isShortCaptionLabel(text);
  const hasCaptionTone = hasQuotedCaptionTone(text);
  const hasCaptionStyleHint = Boolean(
    node.querySelector('em,small') ||
      /font-size\s*:\s*12/i.test(node.getAttribute('style') || '') ||
      /font-size\s*:\s*12/i.test(node.innerHTML || '')
  );
  const allowLoose = Boolean(options.allowLoose);

  if (isSourceLine) {
    return true;
  }

  if (align === 'center') {
    return hasShortCaptionLabel || hasCaptionTone || hasCaptionStyleHint || allowLoose;
  }

  return hasCaptionStyleHint && (hasShortCaptionLabel || hasCaptionTone) && !/[。！？!?]$/.test(text);
}

function isLooseCaptionLeadParagraph(node) {
  if (!(node instanceof HTMLParagraphElement)) {
    return false;
  }

  const text = normalizeText(node.textContent || '');
  if (!text || text.length > 42) {
    return false;
  }
  if (/[。！？!?]$/.test(text)) {
    return false;
  }

  const next = node.nextElementSibling;
  if (next instanceof HTMLParagraphElement) {
    const nextText = normalizeText(next.textContent || '');
    if (!nextText) {
      return true;
    }
    if (/(图片来源|图源|来源[:：])/i.test(nextText)) {
      return true;
    }
  }

  return /[「『【（\(].+[」』】）\)]/.test(text) || /(logo|Logo|示意|包装|二维码|集市|评论|吃法|组合|现场)/i.test(text);
}

function isSourceCaptionLine(text) {
  const normalized = normalizeText(text || '');
  if (!normalized) {
    return false;
  }

  return /(图片来源|图源|来源[:：]|供图|摄影|资料来源|photo\s*source|source[:：])/i.test(normalized);
}

function hasQuotedCaptionTone(text) {
  const normalized = normalizeText(text || '');
  if (!normalized) {
    return false;
  }
  return /[「『【（\(].+[」』】）\)]/.test(normalized);
}

function isShortCaptionLabel(text) {
  const normalized = normalizeText(text || '');
  if (!normalized || normalized.length > 42) {
    return false;
  }
  if (looksLikeBodySentence(normalized)) {
    return false;
  }

  return /(logo|Logo|示意图?|评论截图|评论区|创意吃法|包装|二维码|集市|现场|海报|产品图|封面图|图[0-9一二三四五六七八九十]+)/i.test(
    normalized
  );
}

function looksLikeBodySentence(text) {
  const normalized = normalizeText(text || '');
  if (!normalized) {
    return false;
  }
  if (/^(目录|一、|二、|三、|四、|五、)/.test(normalized)) {
    return true;
  }
  if (normalized.length < 32) {
    return false;
  }
  return /[，,。！？!?；;]/.test(normalized);
}

function isExcludedCaptionLeadText(text) {
  return /^(地址|官网|电话|邮箱|称呼|职位|微信二维码|微信公众号|商务合作联系人)[:：]?$/.test(
    normalizeText(text || '')
  );
}

function appendCaptionLinesToFigure(figure, lines, doc) {
  const normalizedLines = lines.map((line) => normalizeText(line)).filter(Boolean);
  if (!normalizedLines.length) {
    return;
  }

  const figcaption = doc.createElement('figcaption');

  if (normalizedLines.length === 1) {
    const span = doc.createElement('span');
    span.style.color = '#7f7f7f';
    span.style.fontSize = '12px';
    span.textContent = normalizedLines[0];
    figcaption.appendChild(span);
  } else {
    normalizedLines.forEach((line) => {
      const paragraph = doc.createElement('p');
      paragraph.style.textAlign = 'center';
      const span = doc.createElement('span');
      span.style.color = '#7f7f7f';
      span.style.fontSize = '12px';
      span.textContent = line;
      paragraph.appendChild(span);
      figcaption.appendChild(paragraph);
    });
  }

  figure.appendChild(figcaption);
}

async function copyTextToClipboard(text) {
  const normalized = String(text || '');
  if (!normalized) {
    throw new Error('复制内容为空');
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(normalized);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = normalized;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();

  if (!ok) {
    throw new Error('浏览器不支持自动复制，请手动复制');
  }
}
