import { PLATFORM_NAME_MAP } from './platforms.js';

const TARGET_PLATFORM_ID = 'foodtalks';
const TOC_HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const EDITOR_SYNC_DEBOUNCE_MS = 220;
const DIRECT_PUBLISH_MESSAGE_LIMIT_BYTES = 6 * 1024 * 1024;
const CONTENT_CHUNK_CHAR_SIZE = 1_500_000;
const FOODTALKS_PUBLISH_URL = 'https://admin-we.foodtalks.cn/#/radar/news/publish';
let editorSyncTimer = null;
let tocNavigationLock = null;
let tocNavigationUnlockTimer = null;

const dom = {
  feishuAppIdInput: document.getElementById('feishuAppIdInput'),
  feishuAppSecretInput: document.getElementById('feishuAppSecretInput'),
  saveFeishuConfigButton: document.getElementById('saveFeishuConfigButton'),
  feishuConfigStatus: document.getElementById('feishuConfigStatus'),
  urlInput: document.getElementById('urlInput'),
  extractButton: document.getElementById('extractButton'),
  extractStatus: document.getElementById('extractStatus'),
  wordCount: document.getElementById('wordCount'),
  imageCount: document.getElementById('imageCount'),
  paragraphCount: document.getElementById('paragraphCount'),
  validationList: document.getElementById('validationList'),
  titleInput: document.getElementById('titleInput'),
  coverPreview: document.getElementById('coverPreview'),
  editorToolbar: document.getElementById('editorToolbar'),
  formatBlockSelect: document.getElementById('formatBlockSelect'),
  tocList: document.getElementById('tocList'),
  tocCount: document.getElementById('tocCount'),
  contentPreview: document.getElementById('contentPreview'),
  openFoodtalksButton: document.getElementById('openFoodtalksButton'),
  copyFoodtalksCodeButton: document.getElementById('copyFoodtalksCodeButton'),
  syncDraftButton: document.getElementById('syncDraftButton'),
  syncPublishButton: document.getElementById('syncPublishButton'),
  publishProgressBar: document.getElementById('publishProgressBar'),
  publishProgressText: document.getElementById('publishProgressText'),
  publishResultList: document.getElementById('publishResultList'),
  logList: document.getElementById('logList'),
  clearLogsButton: document.getElementById('clearLogsButton'),
  followTabsInput: document.getElementById('followTabsInput')
};

const state = {
  article: null,
  logs: [],
  sourceSettings: {
    feishuAppId: '',
    feishuAppSecret: ''
  }
};

init().catch((error) => {
  setExtractStatus(`初始化失败：${error instanceof Error ? error.message : String(error)}`, 'error');
});

async function init() {
  bindEvents();
  await loadSourceSettings();
  await refreshLogs();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'PUBLISH_PROGRESS') {
      applyPublishProgress(message.payload);
    }

    if (message?.type === 'LOG_UPDATE') {
      state.logs = [message.payload, ...state.logs].slice(0, 100);
      renderLogs(state.logs);
    }
  });
}

function bindEvents() {
  dom.saveFeishuConfigButton?.addEventListener('click', async () => {
    try {
      await saveSourceSettings();
      setFeishuConfigStatus('飞书凭据已保存', 'success');
    } catch (error) {
      setFeishuConfigStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  dom.extractButton.addEventListener('click', async () => {
    try {
      await runExtraction();
    } catch (error) {
      setExtractStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  dom.syncDraftButton?.addEventListener('click', async () => {
    try {
      await runSync('draft');
    } catch (error) {
      dom.publishProgressText.textContent = `同步失败：${error instanceof Error ? error.message : String(error)}`;
    }
  });

  dom.syncPublishButton?.addEventListener('click', async () => {
    try {
      await runSync('publish');
    } catch (error) {
      dom.publishProgressText.textContent = `同步失败：${error instanceof Error ? error.message : String(error)}`;
    }
  });

  dom.clearLogsButton.addEventListener('click', async () => {
    const result = await runtimeSend({ type: 'CLEAR_LOGS' });
    if (!result.ok) {
      setExtractStatus(`日志清理失败：${result.error}`, 'error');
      return;
    }

    await refreshLogs();
    setExtractStatus('日志已清空', 'success');
  });

  dom.openFoodtalksButton?.addEventListener('click', async () => {
    const followTabs = Boolean(dom.followTabsInput?.checked);
    await chrome.tabs.create({
      url: FOODTALKS_PUBLISH_URL,
      active: followTabs
    });
    setExtractStatus('已打开 FoodTalks 发布页，请先确认登录状态', 'success');
  });

  dom.copyFoodtalksCodeButton?.addEventListener('click', async () => {
    try {
      const html = buildFoodtalksPasteHtml(dom.contentPreview.innerHTML || '');
      if (!html) {
        throw new Error('正文为空，无法复制');
      }

      await copyTextToClipboard(html);
      dom.publishProgressBar.style.width = '100%';
      dom.publishProgressText.textContent = '正文 HTML 已复制，可在 FoodTalks 编辑器直接粘贴';
      setExtractStatus('已复制 FoodTalks 正文代码', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dom.publishProgressText.textContent = `复制失败：${message}`;
      setExtractStatus(`复制失败：${message}`, 'error');
    }
  });

  dom.titleInput?.addEventListener('input', () => {
    if (!state.article) {
      return;
    }
    state.article.title = dom.titleInput.value.trim();
  });

  dom.contentPreview?.addEventListener('input', () => {
    if (editorSyncTimer) {
      window.clearTimeout(editorSyncTimer);
    }

    editorSyncTimer = window.setTimeout(() => {
      syncArticleFromEditor();
      renderTocFromPreview();
    }, EDITOR_SYNC_DEBOUNCE_MS);
  });

  dom.contentPreview?.addEventListener('scroll', () => {
    updateTocActiveByScroll();
  }, { passive: true });

  dom.editorToolbar?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest('button[data-command]');
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const command = button.dataset.command || '';
    const value = button.dataset.value || '';
    executeEditorCommand(command, value);
  });

  dom.formatBlockSelect?.addEventListener('change', () => {
    const value = dom.formatBlockSelect?.value || 'p';
    executeEditorCommand('formatBlock', value);
  });

  dom.tocList?.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest('button[data-target-id]');
    if (button) {
      event.preventDefault();
    }
  });

  dom.tocList?.addEventListener('click', (event) => {
    event.preventDefault();
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest('button[data-target-id]');
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const headingId = button.dataset.targetId || '';
    const heading = findHeadingNodeById(headingId);
    if (!heading) {
      return;
    }

    const previewRect = dom.contentPreview.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const targetTop =
      headingRect.top - previewRect.top + dom.contentPreview.scrollTop - 12;
    const normalizedTargetTop = Math.max(0, targetTop);

    lockTocNavigation(headingId, normalizedTargetTop);

    if (dom.contentPreview.scrollHeight > dom.contentPreview.clientHeight + 4) {
      dom.contentPreview.scrollTo({
        top: normalizedTargetTop,
        behavior: 'auto'
      });
    } else {
      heading.scrollIntoView({ behavior: 'auto', block: 'start' });
    }

    setActiveTocItem(headingId);
  });
}

function executeEditorCommand(command, value = '') {
  const normalizedCommand = normalizeText(command);
  if (!normalizedCommand) {
    return;
  }

  dom.contentPreview.focus({ preventScroll: true });

  if (normalizedCommand === 'createLink') {
    const input = window.prompt('请输入链接地址（https://...）', 'https://');
    const rawUrl = normalizeText(input);
    if (!rawUrl) {
      return;
    }
    const url = /^(https?:|mailto:)/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    document.execCommand('createLink', false, url);
  } else if (normalizedCommand === 'removeFormat') {
    document.execCommand('removeFormat', false);
    document.execCommand('unlink', false);
  } else if (normalizedCommand === 'formatBlock') {
    document.execCommand('formatBlock', false, value || 'p');
  } else {
    document.execCommand(normalizedCommand, false, value);
  }

  syncArticleFromEditor();
  renderTocFromPreview();
  updateTocActiveByScroll();
}

async function loadSourceSettings() {
  const response = await runtimeSend({ type: 'GET_SOURCE_SETTINGS' });
  if (!response.ok) {
    setFeishuConfigStatus('无法读取飞书凭据，请手动填写', 'warn');
    return;
  }

  const settings = {
    feishuAppId: response.settings?.feishuAppId || '',
    feishuAppSecret: response.settings?.feishuAppSecret || ''
  };

  state.sourceSettings = settings;

  if (dom.feishuAppIdInput) {
    dom.feishuAppIdInput.value = settings.feishuAppId;
  }
  if (dom.feishuAppSecretInput) {
    dom.feishuAppSecretInput.value = settings.feishuAppSecret;
  }

  if (settings.feishuAppId && settings.feishuAppSecret) {
    setFeishuConfigStatus('已读取飞书凭据，可直接提取', 'success');
  } else {
    setFeishuConfigStatus('请先填写飞书 App ID / App Secret', 'warn');
  }
}

function collectSourceSettings() {
  return {
    feishuAppId: dom.feishuAppIdInput?.value?.trim() || '',
    feishuAppSecret: dom.feishuAppSecretInput?.value?.trim() || ''
  };
}

async function saveSourceSettings() {
  const settings = collectSourceSettings();
  const response = await runtimeSend({
    type: 'SAVE_SOURCE_SETTINGS',
    payload: settings
  });

  if (!response.ok) {
    throw new Error(response.error || '保存飞书凭据失败');
  }

  state.sourceSettings = {
    feishuAppId: response.settings?.feishuAppId || '',
    feishuAppSecret: response.settings?.feishuAppSecret || ''
  };
}

function setFeishuConfigStatus(message, tone = 'info') {
  if (!dom.feishuConfigStatus) {
    return;
  }

  dom.feishuConfigStatus.textContent = message;
  dom.feishuConfigStatus.dataset.tone = tone;
}

async function runExtraction() {
  const url = dom.urlInput.value.trim();
  const followTabs = Boolean(dom.followTabsInput?.checked);
  const isFeishuDoc = /^https?:\/\/([a-z0-9-]+\.)?(feishu\.cn|larkoffice\.com)\/(?:docx|wiki)\//i.test(url);
  const sourceSettings = collectSourceSettings();

  if (!url) {
    throw new Error('请输入飞书云文档链接');
  }

  if (!isFeishuDoc) {
    throw new Error('当前版本仅支持飞书文档链接（/docx/ 或 /wiki/）');
  }

  setExtractBusy(true);
  setExtractStatus('正在提取内容...');

  const response = await runtimeSend({
    type: 'EXTRACT_ARTICLE',
    payload: {
      url,
      forceRefresh: isFeishuDoc,
      manualSelector: '',
      followTabs,
      sourceSettings
    }
  });

  setExtractBusy(false);

  if (!response.ok) {
    throw new Error(response.error || '提取失败');
  }

  state.article = response.data;
  await applyArticle(response.data, sourceSettings);

  const statusText = response.data.cached
    ? '提取完成（缓存命中）'
    : `提取完成（字数 ${response.data.wordCount} / 图片 ${response.data.imageCount}）`;
  setExtractStatus(statusText, response.data.validation?.ok ? 'success' : 'warn');

  await refreshLogs();
}

async function applyArticle(article, sourceSettings = collectSourceSettings()) {
  const normalizedHtml = normalizePreviewHtml(article.contentHtml || '');

  dom.titleInput.value = article.title || '';
  dom.contentPreview.innerHTML = normalizedHtml;

  if (article.coverUrl) {
    dom.coverPreview.src = article.coverUrl;
    dom.coverPreview.classList.remove('placeholder');
  } else {
    dom.coverPreview.removeAttribute('src');
    dom.coverPreview.classList.add('placeholder');
  }

  dom.wordCount.textContent = String(article.wordCount || 0);
  dom.imageCount.textContent = String(article.imageCount || 0);
  dom.paragraphCount.textContent = String(article.paragraphCount || 0);

  renderValidation(article.validation, article.validationHints || []);

  if (state.article) {
    state.article.contentHtml = normalizedHtml;
  }

  renderTocFromPreview();

  await hydrateFeishuPreviewAssets(article, sourceSettings);
  syncArticleFromEditor({ updateMetrics: false });
}

function normalizePreviewHtml(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html || '';

  wrapper.querySelectorAll('script,iframe,meta,link,noscript').forEach((node) => node.remove());
  wrapper.querySelectorAll('img').forEach((img) => {
    img.loading = 'lazy';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
  });

  return wrapper.innerHTML.trim();
}

async function hydrateFeishuPreviewAssets(article, sourceSettings) {
  const coverToken = article?.coverToken || '';
  const nodes = [...dom.contentPreview.querySelectorAll('img[data-feishu-token]')];
  if (!coverToken && nodes.length === 0) {
    return;
  }

  const tokenNodeMap = new Map();
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

  const tokens = [...new Set([coverToken, ...tokenNodeMap.keys()].filter(Boolean))];
  if (!tokens.length) {
    return;
  }

  await runWithConcurrency(tokens, 3, async (token) => {
    const response = await runtimeSend({
      type: 'FETCH_FEISHU_IMAGE',
      payload: {
        mediaToken: token,
        sourceSettings
      }
    });

    if (!response.ok || !response.dataUrl) {
      const relatedNodes = tokenNodeMap.get(token) || [];
      relatedNodes.forEach((node) => {
        node.setAttribute('alt', '图片加载失败');
      });
      return;
    }

    if (!dom.coverPreview.getAttribute('src') && coverToken && token === coverToken) {
      dom.coverPreview.src = response.dataUrl;
      dom.coverPreview.classList.remove('placeholder');
    }

    const relatedNodes = tokenNodeMap.get(token) || [];
    relatedNodes.forEach((node) => {
      node.setAttribute('src', response.dataUrl);
      node.removeAttribute('data-feishu-token');
      node.removeAttribute('data-feishu-block-id');
    });

    if (state.article && Array.isArray(state.article.images)) {
      state.article.images = state.article.images.map((image) =>
        image.token === token
          ? {
              ...image,
              src: response.dataUrl
            }
          : image
      );
    }
  });
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

function renderTocFromPreview() {
  if (!dom.tocList) {
    return;
  }

  const headings = [...dom.contentPreview.querySelectorAll(TOC_HEADING_SELECTOR)].filter((node) =>
    normalizeText(node.textContent).length > 0
  );

  assignHeadingIds(headings);

  dom.tocList.innerHTML = '';
  if (dom.tocCount) {
    dom.tocCount.textContent = String(headings.length);
  }

  if (!headings.length) {
    const li = document.createElement('li');
    li.className = 'ft-toc-empty';
    li.textContent = '未检测到目录标题';
    dom.tocList.appendChild(li);
    return;
  }

  headings.forEach((heading) => {
    const text = normalizeText(heading.textContent);
    if (!text) {
      return;
    }

    const li = document.createElement('li');
    li.className = 'ft-toc-item';

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'ft-toc-link';
    link.dataset.targetId = heading.id;
    link.dataset.level = String(getHeadingLevel(heading.tagName));
    link.style.setProperty('--toc-indent', `${Math.max(0, getHeadingLevel(heading.tagName) - 1) * 12}px`);
    link.textContent = text;

    li.appendChild(link);
    dom.tocList.appendChild(li);
  });

  updateTocActiveByScroll();
}

function assignHeadingIds(headings) {
  const used = new Set();
  headings.forEach((heading, index) => {
    const existing = normalizeText(heading.getAttribute('id'));
    const fallback = normalizeText(heading.textContent) || `section-${index + 1}`;
    const base = slugifyHeading(existing || fallback) || `section-${index + 1}`;
    let unique = base;
    let suffix = 2;
    while (used.has(unique)) {
      unique = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(unique);
    heading.id = unique;
  });
}

function findHeadingNodeById(id) {
  const normalizedId = normalizeText(id);
  if (!normalizedId) {
    return null;
  }

  const escapedId =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(normalizedId)
      : normalizedId.replace(/[^a-zA-Z0-9\-_:\u4e00-\u9fa5]/g, '');
  if (!escapedId) {
    return null;
  }
  return dom.contentPreview.querySelector(`#${escapedId}`);
}

function updateTocActiveByScroll() {
  if (!dom.tocList) {
    return;
  }

  if (tocNavigationLock) {
    const lockAge = Date.now() - tocNavigationLock.createdAt;
    const distance = Math.abs(dom.contentPreview.scrollTop - tocNavigationLock.targetTop);
    if (distance > 8 && lockAge < 500) {
      setActiveTocItem(tocNavigationLock.targetId);
      return;
    }
    unlockTocNavigation();
  }

  const headings = [...dom.contentPreview.querySelectorAll(TOC_HEADING_SELECTOR)];
  if (!headings.length) {
    setActiveTocItem('');
    return;
  }

  const offsetTop = dom.contentPreview.scrollTop + 20;
  let activeId = headings[0].id || '';

  headings.forEach((heading) => {
    if (heading.offsetTop <= offsetTop) {
      activeId = heading.id || activeId;
    }
  });

  setActiveTocItem(activeId);
}

function setActiveTocItem(activeId) {
  dom.tocList?.querySelectorAll('.ft-toc-link').forEach((node) => {
    if (!(node instanceof HTMLButtonElement)) {
      return;
    }
    node.classList.toggle('active', Boolean(activeId) && node.dataset.targetId === activeId);
  });
}

function lockTocNavigation(targetId, targetTop) {
  tocNavigationLock = {
    targetId: normalizeText(targetId),
    targetTop: Math.max(0, Number(targetTop) || 0),
    createdAt: Date.now()
  };

  if (tocNavigationUnlockTimer) {
    window.clearTimeout(tocNavigationUnlockTimer);
  }

  tocNavigationUnlockTimer = window.setTimeout(() => {
    unlockTocNavigation();
    updateTocActiveByScroll();
  }, 520);
}

function unlockTocNavigation() {
  tocNavigationLock = null;
  if (tocNavigationUnlockTimer) {
    window.clearTimeout(tocNavigationUnlockTimer);
    tocNavigationUnlockTimer = null;
  }
}

function getHeadingLevel(tagName) {
  const match = /^H([1-6])$/i.exec(String(tagName || ''));
  return Number(match?.[1] || 1);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugifyHeading(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function syncArticleFromEditor({ updateMetrics = true } = {}) {
  const contentHtml = dom.contentPreview.innerHTML.trim();
  if (state.article) {
    state.article.contentHtml = contentHtml;
    state.article.title = dom.titleInput.value.trim();
  }

  if (!updateMetrics) {
    return;
  }

  const plainText = stripHtml(contentHtml).replace(/\s+/g, '');
  const imageCount = dom.contentPreview.querySelectorAll('img[src]').length;
  const paragraphCount = dom.contentPreview.querySelectorAll(
    'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figure,table'
  ).length;

  dom.wordCount.textContent = String(plainText.length);
  dom.imageCount.textContent = String(imageCount);
  dom.paragraphCount.textContent = String(paragraphCount);
}

function renderValidation(validation, hints = []) {
  const items = [];

  if (validation?.ok) {
    items.push({ level: 'success', text: '内容完整性校验通过' });
  }

  (validation?.missing || []).forEach((item) => {
    items.push({ level: 'error', text: `缺失项：${item}` });
  });

  (validation?.warnings || []).forEach((item) => {
    items.push({ level: 'warn', text: item });
  });

  hints.forEach((item) => {
    items.push({ level: 'warn', text: item });
  });

  if (items.length === 0) {
    items.push({ level: 'info', text: '等待提取后展示校验结果' });
  }

  dom.validationList.innerHTML = '';

  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item.text;
    if (item.level === 'error') {
      li.style.borderColor = '#f1c8c6';
      li.style.color = '#c23934';
    }
    if (item.level === 'warn') {
      li.style.borderColor = '#f2dfbc';
      li.style.color = '#ad6a00';
    }
    if (item.level === 'success') {
      li.style.borderColor = '#bde8d4';
      li.style.color = '#0f8a5f';
    }
    dom.validationList.appendChild(li);
  });
}

async function runSync(publishAction = 'draft') {
  const followTabs = Boolean(dom.followTabsInput?.checked);
  const currentContent = collectCurrentContent(publishAction);

  if (!currentContent.sourceUrl) {
    throw new Error('请先输入来源链接并完成提取');
  }

  if (!currentContent.title) {
    throw new Error('标题不能为空');
  }

  dom.syncDraftButton.disabled = true;
  dom.syncPublishButton.disabled = true;
  dom.publishResultList.innerHTML = '';
  dom.publishProgressBar.style.width = '8%';
  dom.publishProgressText.textContent = publishAction === 'publish' ? '正在同步并发布...' : '正在同步并保存草稿...';

  const response = await sendPublishContent({
    platformIds: [TARGET_PLATFORM_ID],
    content: currentContent,
    followTabs
  });

  dom.syncDraftButton.disabled = false;
  dom.syncPublishButton.disabled = false;

  if (!response.ok) {
    throw new Error(response.error || '同步失败');
  }

  renderPublishResults(response.results || []);

  const summary = response.summary || { total: 0, success: 0, failed: 0 };
  dom.publishProgressBar.style.width = '100%';
  dom.publishProgressText.textContent = `完成：成功 ${summary.success}/${summary.total}，失败 ${summary.failed}`;

  await refreshLogs();
}

function collectCurrentContent(publishAction) {
  const article = state.article || {};
  const contentHtml = dom.contentPreview.innerHTML.trim();
  const sourceUrl = dom.urlInput.value.trim();
  const preferImporter = false;

  return {
    title: dom.titleInput.value.trim(),
    sourceUrl,
    coverUrl: article.coverUrl || dom.coverPreview.getAttribute('src') || '',
    contentHtml,
    textPlain: stripHtml(contentHtml),
    images: extractImagesFromHtml(contentHtml),
    publishAction,
    preferImporter
  };
}

async function sendPublishContent({ platformIds, content, followTabs }) {
  const serialized = JSON.stringify(content || {});
  const contentBytes = new TextEncoder().encode(serialized).length;

  if (contentBytes <= DIRECT_PUBLISH_MESSAGE_LIMIT_BYTES) {
    return runtimeSend({
      type: 'PUBLISH_CONTENT',
      payload: {
        platformIds,
        content,
        followTabs
      }
    });
  }

  const transferId = `content_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const totalChunks = Math.max(1, Math.ceil(serialized.length / CONTENT_CHUNK_CHAR_SIZE));

  const beginResult = await runtimeSend({
    type: 'BEGIN_CONTENT_TRANSFER',
    payload: {
      transferId,
      totalChunks,
      contentSize: contentBytes
    }
  });

  if (!beginResult.ok) {
    return beginResult;
  }

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * CONTENT_CHUNK_CHAR_SIZE;
      const chunk = serialized.slice(start, start + CONTENT_CHUNK_CHAR_SIZE);
      const appendResult = await runtimeSend({
        type: 'APPEND_CONTENT_CHUNK',
        payload: {
          transferId,
          index,
          chunk
        }
      });

      if (!appendResult.ok) {
        return appendResult;
      }

      const uploadPercent = Math.round(((index + 1) / totalChunks) * 100);
      dom.publishProgressBar.style.width = `${Math.max(10, Math.min(36, 8 + Math.round(uploadPercent * 0.28)))}%`;
      dom.publishProgressText.textContent = `正在上传大内容分片（${index + 1}/${totalChunks}）...`;
    }

    return await runtimeSend({
      type: 'PUBLISH_CONTENT',
      payload: {
        platformIds,
        contentTransferId: transferId,
        followTabs
      }
    });
  } finally {
    await runtimeSend({
      type: 'CLEAR_CONTENT_TRANSFER',
      payload: { transferId }
    });
  }
}

function extractImagesFromHtml(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html || '';

  return [...wrapper.querySelectorAll('img[src]')]
    .map((img, index) => {
      const figure = img.closest('figure');
      const caption = figure?.querySelector('figcaption')?.textContent?.trim() || '';
      return {
        index,
        src: img.getAttribute('src') || '',
        alt: img.getAttribute('alt') || '',
        caption
      };
    })
    .filter((item) => item.src);
}

function applyPublishProgress(payload) {
  if (!payload) return;

  const total = payload.total || 1;
  const current = payload.current || 0;
  const ratio = Math.min(100, Math.max(0, Math.round((current / total) * 100)));

  dom.publishProgressBar.style.width = `${Math.max(10, ratio)}%`;
  dom.publishProgressText.textContent = payload.message || '处理中...';
}

function renderPublishResults(results) {
  dom.publishResultList.innerHTML = '';

  if (!results.length) {
    const li = document.createElement('li');
    li.textContent = '暂无同步结果';
    dom.publishResultList.appendChild(li);
    return;
  }

  results.forEach((result) => {
    const li = document.createElement('li');
    const name = escapeHtml(result.platformName || result.platformId || '平台');

    if (result.status === 'success') {
      const warnings = Array.isArray(result.warnings) && result.warnings.length
        ? `；提示：${escapeHtml(result.warnings.join('；'))}`
        : '';
      li.innerHTML = `<strong>${name}</strong>：自动填充完成（尝试 ${result.attempts} 次）${warnings}`;
      li.style.borderColor = '#bde8d4';
      li.style.color = '#0f8a5f';
    } else {
      li.innerHTML = `<strong>${name}</strong>：失败，${escapeHtml(result.error || '未知错误')}`;
      li.style.borderColor = '#f1c8c6';
      li.style.color = '#c23934';
    }

    dom.publishResultList.appendChild(li);
  });
}

async function refreshLogs() {
  const response = await runtimeSend({ type: 'GET_LOGS' });
  if (!response.ok) return;

  state.logs = (response.logs || []).slice(0, 120);
  renderLogs(state.logs);
}

function renderLogs(logs) {
  dom.logList.innerHTML = '';

  if (!logs.length) {
    const li = document.createElement('li');
    li.textContent = '暂无日志';
    dom.logList.appendChild(li);
    return;
  }

  logs.forEach((log) => {
    const li = document.createElement('li');
    const time = new Date(log.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
    const stage = escapeHtml(log.stage || 'system');
    const message = escapeHtml(log.message || '');
    li.innerHTML = `<strong>[${time}] [${stage}]</strong> ${message}`;
  
    if (log.level === 'error') li.style.color = '#c23934';
    if (log.level === 'warn') li.style.color = '#ad6a00';

    dom.logList.appendChild(li);
  });
}

function setExtractStatus(message, tone = 'info') {
  dom.extractStatus.textContent = message;
  dom.extractStatus.dataset.tone = tone;
}

function setExtractBusy(busy) {
  dom.extractButton.disabled = busy;
  dom.extractButton.textContent = busy ? '提取中...' : '提取内容';
}

async function runtimeSend(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  if (/^(https?:|blob:)/i.test(raw)) return raw;
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

window.__APP_DEBUG__ = {
  getState: () => ({ ...state, platformNameMap: PLATFORM_NAME_MAP })
};
