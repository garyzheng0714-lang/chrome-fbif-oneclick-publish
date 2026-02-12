import { RichEditor } from './editor.js';
import { PLATFORM_DEFINITIONS, PLATFORM_NAME_MAP } from './platforms.js';

const dom = {
  urlInput: document.getElementById('urlInput'),
  selectorInput: document.getElementById('selectorInput'),
  extractButton: document.getElementById('extractButton'),
  manualExtractButton: document.getElementById('manualExtractButton'),
  refreshExtractButton: document.getElementById('refreshExtractButton'),
  extractStatus: document.getElementById('extractStatus'),
  wordCount: document.getElementById('wordCount'),
  imageCount: document.getElementById('imageCount'),
  paragraphCount: document.getElementById('paragraphCount'),
  validationList: document.getElementById('validationList'),
  coverPreview: document.getElementById('coverPreview'),
  replaceCoverButton: document.getElementById('replaceCoverButton'),
  coverFileInput: document.getElementById('coverFileInput'),
  titleInput: document.getElementById('titleInput'),
  platformList: document.getElementById('platformList'),
  publishButton: document.getElementById('publishButton'),
  publishProgressBar: document.getElementById('publishProgressBar'),
  publishProgressText: document.getElementById('publishProgressText'),
  publishResultList: document.getElementById('publishResultList'),
  logList: document.getElementById('logList'),
  failedDraftList: document.getElementById('failedDraftList'),
  clearLogsButton: document.getElementById('clearLogsButton'),
  followTabsInput: document.getElementById('followTabsInput'),
  editor: document.getElementById('editor'),
  toolbar: document.getElementById('toolbar'),
  headingSelect: document.getElementById('headingSelect'),
  editorPanel: document.getElementById('editorPanel'),
  formatPainterButton: document.getElementById('formatPainterButton'),
  fullscreenButton: document.getElementById('fullscreenButton')
};

const state = {
  article: null,
  logs: [],
  failedDrafts: []
};

const editor = new RichEditor({
  editor: dom.editor,
  toolbar: dom.toolbar,
  headingSelect: dom.headingSelect,
  editorPanel: dom.editorPanel,
  formatPainterButton: dom.formatPainterButton,
  fullscreenButton: dom.fullscreenButton
});

init().catch((error) => {
  setExtractStatus(`初始化失败：${error instanceof Error ? error.message : String(error)}`, 'error');
});

async function init() {
  renderPlatformCards();
  bindEvents();
  setExtractStatus('请输入微信公众号链接并点击“智能提取”');
  await refreshLogs();
  await refreshFailedDrafts();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'PUBLISH_PROGRESS') {
      applyPublishProgress(message.payload);
    }

    if (message?.type === 'LOG_UPDATE') {
      state.logs = [message.payload, ...state.logs].slice(0, 60);
      renderLogs(state.logs);
    }
  });

  window.setInterval(() => {
    refreshLogs().catch(() => undefined);
  }, 8_000);
}

function bindEvents() {
  dom.extractButton.addEventListener('click', () => {
    runExtraction({ forceRefresh: false, useManualSelector: false }).catch((error) => {
      setExtractStatus(error instanceof Error ? error.message : String(error), 'error');
    });
  });

  dom.refreshExtractButton.addEventListener('click', () => {
    runExtraction({ forceRefresh: true, useManualSelector: false }).catch((error) => {
      setExtractStatus(error instanceof Error ? error.message : String(error), 'error');
    });
  });

  dom.manualExtractButton.addEventListener('click', () => {
    runExtraction({ forceRefresh: true, useManualSelector: true }).catch((error) => {
      setExtractStatus(error instanceof Error ? error.message : String(error), 'error');
    });
  });

  dom.replaceCoverButton.addEventListener('click', () => {
    dom.coverFileInput.click();
  });

  dom.coverFileInput.addEventListener('change', async () => {
    const file = dom.coverFileInput.files?.[0];
    if (!file) {
      return;
    }

    try {
      const compressed = await compressImage(file);
      dom.coverPreview.src = compressed;
      if (!state.article) {
        state.article = createEmptyArticle();
      }
      state.article.coverUrl = compressed;
      setExtractStatus('封面已替换并压缩完成');
    } catch (error) {
      setExtractStatus(`封面处理失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      dom.coverFileInput.value = '';
    }
  });

  dom.publishButton.addEventListener('click', () => {
    runPublishing().catch((error) => {
      dom.publishProgressText.textContent = `发布失败：${error instanceof Error ? error.message : String(error)}`;
    });
  });

  dom.clearLogsButton.addEventListener('click', async () => {
    const result = await runtimeSend({ type: 'CLEAR_LOGS' });
    if (!result.ok) {
      setExtractStatus(`日志清理失败：${result.error}`, 'error');
      return;
    }

    await refreshLogs();
    setExtractStatus('日志已清空');
  });

  dom.failedDraftList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-draft]');
    if (!button) {
      return;
    }

    const draftId = button.dataset.copyDraft;
    const draft = state.failedDrafts.find((item) => item.id === draftId);

    if (!draft) {
      return;
    }

    const text = [
      `标题：${draft.title}`,
      `封面：${draft.coverUrl || '无'}`,
      '',
      draft.textPlain || stripHtml(draft.contentHtml)
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
      <span class="platform-meta">
        <span class="platform-name">${platform.name}</span>
        <span class="platform-desc">${platform.description}</span>
      </span>
    `;

    dom.platformList.appendChild(label);
  });
}

async function runExtraction({ forceRefresh, useManualSelector }) {
  const url = dom.urlInput.value.trim();
  const manualSelector = useManualSelector ? dom.selectorInput.value.trim() : '';
  const followTabs = Boolean(dom.followTabsInput?.checked);

  if (!url) {
    throw new Error('请输入公众号链接');
  }

  if (useManualSelector && !manualSelector) {
    throw new Error('手动补提模式需要填写 CSS 选择器');
  }

  setExtractBusy(true);
  setExtractStatus('正在提取内容，请稍候...');

  const response = await runtimeSend({
    type: 'EXTRACT_ARTICLE',
    payload: {
      url,
      forceRefresh,
      manualSelector,
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
  dom.titleInput.value = article.title || '';
  const normalizedHtml = normalizeEditorHtml(article.contentHtml || '');
  editor.setContentHtml(normalizedHtml);
  if (state.article) {
    state.article.contentHtml = normalizedHtml;
  }

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
}

function normalizeEditorHtml(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;

  wrapper
    .querySelectorAll(
      'script,style,iframe,link,meta,.qr_code_pc,.wx_profile_card_container,.rich_media_meta_list,[style*=\"display:none\"]'
    )
    .forEach((node) => node.remove());

  wrapper.querySelectorAll('img').forEach((img) => {
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
  });

  wrapper.querySelectorAll('p,div,section').forEach((node) => {
    const text = node.textContent?.replace(/\s+/g, ' ').trim() || '';
    const hasImage = node.querySelector('img');
    if (!text && !hasImage) {
      node.remove();
    }
  });

  return wrapper.innerHTML.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>').trim();
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

  hints.forEach((hint) => {
    items.push({ level: 'warn', text: hint });
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
  const selectedPlatformIds = [...document.querySelectorAll('.platform-checkbox:checked')].map(
    (node) => node.value
  );

  if (selectedPlatformIds.length === 0) {
    throw new Error('请先选择发布平台');
  }

  const contentPayload = collectCurrentContent();
  const followTabs = Boolean(dom.followTabsInput?.checked);

  if (!contentPayload.title) {
    throw new Error('请先填写标题');
  }

  if (!contentPayload.contentHtml.trim() && !contentPayload.textPlain.trim()) {
    throw new Error('正文内容为空，无法发布');
  }

  dom.publishButton.disabled = true;
  dom.publishProgressBar.style.width = '4%';
  dom.publishProgressText.textContent = '开始同步发布...';
  dom.publishResultList.innerHTML = '';

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

  await refreshFailedDrafts();
  await refreshLogs();
}

function collectCurrentContent() {
  const contentHtml = editor.getContentHtml();
  const textPlain = editor.getPlainText();
  const images = editor.getImages();
  const previewCover = dom.coverPreview.getAttribute('src') || '';

  return {
    title: dom.titleInput.value.trim(),
    coverUrl: state.article?.coverUrl || previewCover,
    contentHtml,
    textPlain,
    images
  };
}

function applyPublishProgress(payload) {
  if (!payload) {
    return;
  }

  const total = payload.total || 1;
  const current = payload.current || 0;
  const ratio = Math.min(100, Math.max(0, Math.round((current / total) * 100)));

  if (payload.phase === 'running') {
    dom.publishProgressBar.style.width = `${Math.max(8, ratio)}%`;
  } else if (payload.phase === 'finish') {
    dom.publishProgressBar.style.width = '100%';
  } else {
    dom.publishProgressBar.style.width = `${Math.max(6, ratio)}%`;
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
      li.innerHTML = `
        <strong>${result.platformName}</strong>
        <span>自动填充完成（尝试 ${result.attempts} 次）</span>
      `;
    } else {
      li.innerHTML = `
        <strong>${result.platformName}</strong>
        <span>失败：${result.error || '未知错误'}（已保存回退草稿）</span>
      `;
    }

    dom.publishResultList.appendChild(li);
  });
}

async function refreshLogs() {
  const response = await runtimeSend({ type: 'GET_LOGS' });
  if (!response.ok) {
    return;
  }

  state.logs = (response.logs || []).slice(0, 60);
  renderLogs(state.logs);
}

function renderLogs(logs) {
  dom.logList.innerHTML = '';

  if (!logs.length) {
    const li = document.createElement('li');
    li.className = 'log-item';
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
  if (!response.ok) {
    return;
  }

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
      <div class="draft-info">
        <strong>${platformName}</strong>
        <span>${createdAt}</span>
        <span class="draft-error">${draft.errorMessage || '未知错误'}</span>
      </div>
      <button class="ghost" data-copy-draft="${draft.id}">复制草稿</button>
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
  dom.manualExtractButton.disabled = busy;
  dom.refreshExtractButton.disabled = busy;
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

async function compressImage(file, maxWidth = 1920, quality = 0.86) {
  const dataUrl = await fileToDataUrl(file);
  const image = await loadImage(dataUrl);

  const ratio = image.width > maxWidth ? maxWidth / image.width : 1;
  const width = Math.round(image.width * ratio);
  const height = Math.round(image.height * ratio);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    return dataUrl;
  }

  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

async function loadImage(src) {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}

function createEmptyArticle() {
  return {
    title: '',
    coverUrl: '',
    contentHtml: '',
    textPlain: '',
    wordCount: 0,
    imageCount: 0,
    paragraphCount: 0,
    images: []
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
