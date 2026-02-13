import { PLATFORM_DEFINITIONS, PLATFORM_NAME_MAP } from './platforms.js';

const dom = {
  urlInput: document.getElementById('urlInput'),
  extractButton: document.getElementById('extractButton'),
  extractStatus: document.getElementById('extractStatus'),
  wordCount: document.getElementById('wordCount'),
  imageCount: document.getElementById('imageCount'),
  paragraphCount: document.getElementById('paragraphCount'),
  validationList: document.getElementById('validationList'),
  coverPreview: document.getElementById('coverPreview'),
  titleInput: document.getElementById('titleInput'),
  contentPreview: document.getElementById('contentPreview'),
  platformList: document.getElementById('platformList'),
  publishButton: document.getElementById('publishButton'),
  publishProgressBar: document.getElementById('publishProgressBar'),
  publishProgressText: document.getElementById('publishProgressText'),
  publishResultList: document.getElementById('publishResultList'),
  logList: document.getElementById('logList'),
  failedDraftList: document.getElementById('failedDraftList'),
  clearLogsButton: document.getElementById('clearLogsButton'),
  followTabsInput: document.getElementById('followTabsInput')
};

const state = {
  article: null,
  logs: [],
  failedDrafts: []
};

init().catch((error) => {
  setExtractStatus(`初始化失败：${error instanceof Error ? error.message : String(error)}`, 'error');
});

async function init() {
  renderPlatformCards();
  bindEvents();
  await refreshLogs();
  await refreshFailedDrafts();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'PUBLISH_PROGRESS') {
      applyPublishProgress(message.payload);
    }

    if (message?.type === 'LOG_UPDATE') {
      state.logs = [message.payload, ...state.logs].slice(0, 80);
      renderLogs(state.logs);
    }
  });
}

function bindEvents() {
  dom.extractButton.addEventListener('click', async () => {
    try {
      await runExtraction();
    } catch (error) {
      setExtractStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  dom.publishButton.addEventListener('click', async () => {
    try {
      await runPublishing();
    } catch (error) {
      dom.publishProgressText.textContent = `发布失败：${error instanceof Error ? error.message : String(error)}`;
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

  dom.failedDraftList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-draft]');
    if (!button) return;

    const draftId = button.dataset.copyDraft;
    const draft = state.failedDrafts.find((item) => item.id === draftId);
    if (!draft) return;

    const text = [
      `标题：${draft.title}`,
      `封面：${draft.coverUrl || '无'}`,
      '',
      draft.textPlain || stripHtml(draft.contentHtml || '')
    ]
      .join('\n')
      .trim();

    await copyText(text);
    button.textContent = '已复制';
    window.setTimeout(() => {
      button.textContent = '复制草稿';
    }, 1200);
  });
}

function renderPlatformCards() {
  dom.platformList.innerHTML = '';

  PLATFORM_DEFINITIONS.forEach((platform) => {
    const label = document.createElement('label');
    label.className = 'platform-card';
    label.innerHTML = `
      <input type="checkbox" class="platform-checkbox" value="${platform.id}" />
      <span class="platform-icon">${platform.icon}</span>
      <span class="platform-name">${platform.name}</span>
      <small>${platform.description}</small>
    `;
    dom.platformList.appendChild(label);
  });
}

async function runExtraction() {
  const url = dom.urlInput.value.trim();
  const followTabs = Boolean(dom.followTabsInput?.checked);

  if (!url) {
    throw new Error('请输入公众号链接');
  }

  setExtractBusy(true);
  setExtractStatus('正在提取内容，请稍候...');

  const response = await runtimeSend({
    type: 'EXTRACT_ARTICLE',
    payload: {
      url,
      forceRefresh: false,
      manualSelector: '',
      followTabs
    }
  });

  setExtractBusy(false);

  if (!response.ok) {
    throw new Error(response.error || '提取失败');
  }

  state.article = response.data;
  applyArticle(response.data);

  const statusText = response.data.cached
    ? '提取完成（缓存命中）'
    : `提取完成（字数 ${response.data.wordCount} / 图片 ${response.data.imageCount}）`;
  setExtractStatus(statusText, response.data.validation?.ok ? 'success' : 'warn');

  await refreshLogs();
}

function applyArticle(article) {
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
}

function normalizePreviewHtml(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html || '';

  wrapper.querySelectorAll('script,style,iframe,link,meta,noscript').forEach((node) => node.remove());

  wrapper.querySelectorAll('*').forEach((node) => {
    node.removeAttribute('id');
    node.removeAttribute('class');
    node.removeAttribute('style');
    node.removeAttribute('data-id');
    node.removeAttribute('onclick');
    node.removeAttribute('onload');
  });

  wrapper.querySelectorAll('img').forEach((img) => {
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.loading = 'lazy';
  });

  return wrapper.innerHTML.trim();
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
    items.push({ level: 'info', text: '等待提取后展示完整性结果' });
  }

  dom.validationList.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = `validation-item level-${item.level}`;
    li.textContent = item.text;
    dom.validationList.appendChild(li);
  });
}

async function runPublishing() {
  const selectedPlatformIds = [...document.querySelectorAll('.platform-checkbox:checked')].map((node) => node.value);

  if (!selectedPlatformIds.length) {
    throw new Error('请先选择发布平台');
  }

  const contentPayload = collectCurrentContent();
  const followTabs = Boolean(dom.followTabsInput?.checked);

  if (!contentPayload.title) {
    throw new Error('标题不能为空');
  }

  if (!contentPayload.contentHtml.trim()) {
    throw new Error('正文为空，无法发布');
  }

  dom.publishButton.disabled = true;
  dom.publishResultList.innerHTML = '';
  dom.publishProgressBar.style.width = '6%';
  dom.publishProgressText.textContent = '开始同步发布...';

  const response = await runtimeSend({
    type: 'PUBLISH_CONTENT',
    payload: {
      platformIds: selectedPlatformIds,
      content: contentPayload,
      followTabs
    }
  });

  dom.publishButton.disabled = false;

  if (!response.ok) {
    throw new Error(response.error || '发布失败');
  }

  renderPublishResults(response.results || []);

  const summary = response.summary || { total: 0, success: 0, failed: 0 };
  dom.publishProgressBar.style.width = '100%';
  dom.publishProgressText.textContent = `完成：成功 ${summary.success}/${summary.total}，失败 ${summary.failed}`;

  await refreshLogs();
  await refreshFailedDrafts();
}

function collectCurrentContent() {
  const article = state.article || {};
  const contentHtml = dom.contentPreview.innerHTML.trim();
  const textPlain = stripHtml(contentHtml);

  return {
    title: dom.titleInput.value.trim(),
    coverUrl: article.coverUrl || dom.coverPreview.getAttribute('src') || '',
    contentHtml,
    textPlain,
    images: extractImagesFromHtml(contentHtml)
  };
}

function extractImagesFromHtml(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html || '';
  return [...wrapper.querySelectorAll('img[src]')]
    .map((img, index) => ({ index, src: img.getAttribute('src') || '' }))
    .filter((item) => item.src);
}

function applyPublishProgress(payload) {
  if (!payload) return;

  const total = payload.total || 1;
  const current = payload.current || 0;
  const ratio = Math.min(100, Math.max(0, Math.round((current / total) * 100)));

  if (payload.phase === 'running') {
    dom.publishProgressBar.style.width = `${Math.max(10, ratio)}%`;
  } else if (payload.phase === 'finish') {
    dom.publishProgressBar.style.width = '100%';
  } else {
    dom.publishProgressBar.style.width = `${Math.max(8, ratio)}%`;
  }

  dom.publishProgressText.textContent = payload.message || '处理中...';
}

function renderPublishResults(results) {
  dom.publishResultList.innerHTML = '';

  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'publish-result neutral';
    li.textContent = '暂无发布结果';
    dom.publishResultList.appendChild(li);
    return;
  }

  results.forEach((result) => {
    const li = document.createElement('li');
    li.className = `publish-result ${result.status === 'success' ? 'success' : 'failed'}`;

    if (result.status === 'success') {
      li.innerHTML = `<strong>${result.platformName}</strong><span>自动填充完成（尝试 ${result.attempts} 次）</span>`;
    } else {
      li.innerHTML = `<strong>${result.platformName}</strong><span>失败：${result.error || '未知错误'}（已保存回退草稿）</span>`;
    }

    dom.publishResultList.appendChild(li);
  });
}

async function refreshLogs() {
  const response = await runtimeSend({ type: 'GET_LOGS' });
  if (!response.ok) return;

  state.logs = (response.logs || []).slice(0, 100);
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
    li.className = `log-item level-${log.level}`;
    const time = new Date(log.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
    li.textContent = `[${time}] [${log.stage}] ${log.message}`;
    dom.logList.appendChild(li);
  });
}

async function refreshFailedDrafts() {
  const response = await runtimeSend({ type: 'GET_FAILED_DRAFTS' });
  if (!response.ok) return;

  state.failedDrafts = (response.drafts || []).slice(0, 10);
  renderFailedDrafts(state.failedDrafts);
}

function renderFailedDrafts(drafts) {
  dom.failedDraftList.innerHTML = '';

  if (!drafts.length) {
    const li = document.createElement('li');
    li.className = 'draft-item';
    li.textContent = '暂无回退草稿';
    dom.failedDraftList.appendChild(li);
    return;
  }

  drafts.forEach((draft) => {
    const li = document.createElement('li');
    li.className = 'draft-item';

    const platformName = PLATFORM_NAME_MAP[draft.platformId] || draft.platformId;
    const createdAt = new Date(draft.createdAt).toLocaleString('zh-CN', { hour12: false });

    li.innerHTML = `
      <div>
        <strong>${platformName}</strong>
        <span>${createdAt}</span>
        <small>${draft.errorMessage || '未知错误'}</small>
      </div>
      <button class="secondary outline" type="button" data-copy-draft="${draft.id}">复制草稿</button>
    `;

    dom.failedDraftList.appendChild(li);
  });
}

function setExtractStatus(message, tone = 'info') {
  dom.extractStatus.textContent = message;
  dom.extractStatus.dataset.tone = tone;
}

function setExtractBusy(busy) {
  dom.extractButton.disabled = busy;
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

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}
