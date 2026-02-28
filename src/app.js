import { buildFoodtalksPasteHtml, validatePublishHtmlImages } from './shared/foodtalks-html.js';
import { mapErrorToRecovery } from './shared/error-mapping.js';
import { WORKBENCH_STATES, getStatePermissions, transitionState } from './shared/workbench-state.js';

const WORKBENCH_SESSION_KEY = 'fbif_workbench_session_v1';
const RUN_HISTORY_KEY = 'fbif_run_history_v1';
const MAX_RUN_HISTORY = 20;
const DIRECT_PUBLISH_MESSAGE_LIMIT_BYTES = 6 * 1024 * 1024;
const CONTENT_CHUNK_CHAR_SIZE = 1_500_000;

const DEFAULT_FEISHU_APP_ID = 'cli_a9f7f8703778dcee';
const DEFAULT_FEISHU_APP_SECRET = 'iqMX8dolH5aObUzgM18MQbtWvtfwKymM';

const dom = {
  feishuAppIdInput: document.getElementById('feishuAppIdInput'),
  feishuAppSecretInput: document.getElementById('feishuAppSecretInput'),
  saveFeishuConfigButton: document.getElementById('saveFeishuConfigButton'),
  feishuConfigStatus: document.getElementById('feishuConfigStatus'),
  defaultCredentialNotice: document.getElementById('defaultCredentialNotice'),
  urlInput: document.getElementById('urlInput'),
  extractButton: document.getElementById('extractButton'),
  extractStatus: document.getElementById('extractStatus'),
  wordCount: document.getElementById('wordCount'),
  imageCount: document.getElementById('imageCount'),
  paragraphCount: document.getElementById('paragraphCount'),
  validationList: document.getElementById('validationList'),
  titleInput: document.getElementById('titleInput'),
  contentPreview: document.getElementById('contentPreview'),
  copyAndOpenButton: document.getElementById('copyAndOpenButton'),
  syncDraftButton: document.getElementById('syncDraftButton'),
  syncPublishButton: document.getElementById('syncPublishButton'),
  publishProgressBar: document.getElementById('publishProgressBar'),
  publishProgressText: document.getElementById('publishProgressText'),
  publishResultList: document.getElementById('publishResultList'),
  diagnosticsList: document.getElementById('diagnosticsList'),
  runChecksButton: document.getElementById('runChecksButton'),
  openFoodtalksLoginButton: document.getElementById('openFoodtalksLoginButton'),
  rerunLastButton: document.getElementById('rerunLastButton'),
  runHistoryList: document.getElementById('runHistoryList'),
  logList: document.getElementById('logList'),
  clearLogsButton: document.getElementById('clearLogsButton')
};

const state = {
  current: WORKBENCH_STATES.IDLE,
  article: null,
  sourceSettings: {
    feishuAppId: '',
    feishuAppSecret: ''
  },
  diagnostics: [],
  logs: [],
  runHistory: [],
  busy: false
};

init().catch((error) => {
  renderError(error, WORKBENCH_STATES.ERROR);
});

async function init() {
  bindEvents();
  await Promise.all([loadSourceSettings(), restoreWorkbenchSession(), loadRunHistory(), refreshLogs()]);

  await runPrepublishChecks();
  setState(WORKBENCH_STATES.READY);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'PUBLISH_PROGRESS') {
      applyPublishProgress(message.payload);
      return;
    }

    if (message?.type === 'LOG_UPDATE') {
      state.logs = [message.payload, ...state.logs].slice(0, 120);
      renderLogs(state.logs);
    }
  });
}

function bindEvents() {
  dom.saveFeishuConfigButton?.addEventListener('click', async () => {
    try {
      await saveSourceSettings();
      setFeishuConfigStatus('凭据已保存', 'success');
      await runPrepublishChecks();
    } catch (error) {
      renderError(error);
    }
  });

  dom.extractButton?.addEventListener('click', async () => {
    await runExtraction().catch((error) => renderError(error));
  });

  dom.copyAndOpenButton?.addEventListener('click', async () => {
    await copyAndOpenPublishPage().catch((error) => renderError(error));
  });

  dom.openFoodtalksLoginButton?.addEventListener('click', async () => {
    await openFoodtalksLogin().catch((error) => renderError(error));
  });

  dom.syncDraftButton?.addEventListener('click', async () => {
    await runAutoPublish('draft').catch((error) => renderError(error));
  });

  dom.syncPublishButton?.addEventListener('click', async () => {
    await runAutoPublish('publish').catch((error) => renderError(error));
  });

  dom.runChecksButton?.addEventListener('click', async () => {
    await runPrepublishChecks().catch((error) => renderError(error));
  });

  dom.clearLogsButton?.addEventListener('click', async () => {
    try {
      const response = await runtimeSend({ type: 'CLEAR_LOGS' });
      if (!response.ok) {
        throw new Error(response.error || '清空日志失败');
      }
      await refreshLogs();
    } catch (error) {
      renderError(error);
    }
  });

  dom.diagnosticsList?.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest('button[data-action-type]');
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const actionType = button.dataset.actionType || '';
    await handleRecoveryAction(actionType).catch((error) => renderError(error));
  });

  dom.rerunLastButton?.addEventListener('click', async () => {
    const latestExtract = state.runHistory.find((item) => item.type === 'extract' && item.status === 'success');
    if (!latestExtract?.url) {
      setExtractStatus('没有可重跑的历史任务', 'warn');
      return;
    }
    dom.urlInput.value = latestExtract.url;
    await runExtraction().catch((error) => renderError(error));
  });

  dom.urlInput?.addEventListener('input', persistWorkbenchSessionDebounced);
  dom.titleInput?.addEventListener('input', persistWorkbenchSessionDebounced);
  dom.contentPreview?.addEventListener('input', () => {
    if (state.article) {
      state.article.contentHtml = dom.contentPreview.innerHTML.trim();
    }
    persistWorkbenchSessionDebounced();
  });
}

let persistSessionTimer = null;
function persistWorkbenchSessionDebounced() {
  if (persistSessionTimer) {
    window.clearTimeout(persistSessionTimer);
  }
  persistSessionTimer = window.setTimeout(() => {
    persistWorkbenchSession().catch(() => undefined);
  }, 200);
}

function setState(nextState) {
  const normalized = transitionState(state.current, nextState);
  state.current = normalized;

  const permissions = getStatePermissions(state.current);
  dom.extractButton.disabled = state.busy || !permissions.canExtract;
  dom.copyAndOpenButton.disabled = state.busy || !permissions.canCopyAndOpen;
  dom.syncDraftButton.disabled = state.busy || !permissions.canAutoPublish;
  dom.syncPublishButton.disabled = state.busy || !permissions.canAutoPublish;
  dom.runChecksButton.disabled = state.busy || !permissions.canRunChecks;
}

function setBusy(busy) {
  state.busy = Boolean(busy);
  setState(state.current);
}

async function loadSourceSettings() {
  const response = await runtimeSend({ type: 'GET_SOURCE_SETTINGS' });
  if (!response.ok) {
    throw new Error(response.error || '读取凭据失败');
  }

  state.sourceSettings = {
    feishuAppId: response.settings?.feishuAppId || '',
    feishuAppSecret: response.settings?.feishuAppSecret || ''
  };
  dom.feishuAppIdInput.value = state.sourceSettings.feishuAppId;
  dom.feishuAppSecretInput.value = state.sourceSettings.feishuAppSecret;
  syncDefaultCredentialNotice();
}

async function saveSourceSettings() {
  const payload = collectSourceSettings();
  const response = await runtimeSend({ type: 'SAVE_SOURCE_SETTINGS', payload });
  if (!response.ok) {
    throw new Error(response.error || '保存凭据失败');
  }

  state.sourceSettings = {
    feishuAppId: response.settings?.feishuAppId || '',
    feishuAppSecret: response.settings?.feishuAppSecret || ''
  };
  dom.feishuAppIdInput.value = state.sourceSettings.feishuAppId;
  dom.feishuAppSecretInput.value = state.sourceSettings.feishuAppSecret;
  syncDefaultCredentialNotice();
}

function collectSourceSettings() {
  return {
    feishuAppId: String(dom.feishuAppIdInput?.value || '').trim(),
    feishuAppSecret: String(dom.feishuAppSecretInput?.value || '').trim()
  };
}

function syncDefaultCredentialNotice() {
  const useDefault =
    state.sourceSettings.feishuAppId === DEFAULT_FEISHU_APP_ID &&
    state.sourceSettings.feishuAppSecret === DEFAULT_FEISHU_APP_SECRET;
  dom.defaultCredentialNotice.hidden = !useDefault;
}

async function runExtraction() {
  const url = String(dom.urlInput?.value || '').trim();
  if (!url) {
    throw new Error('SOURCE_URL_INVALID: 请输入飞书文档链接');
  }
  if (!isFeishuDocUrl(url)) {
    throw new Error('SOURCE_URL_INVALID: 仅支持飞书 docx/wiki 链接');
  }

  setBusy(true);
  setState(WORKBENCH_STATES.EXTRACTING);
  setExtractStatus('提取中...', 'info');
  clearPublishResult();
  const startedAt = Date.now();

  try {
    await saveSourceSettings();
    const response = await runtimeSend({
      type: 'EXTRACT_ARTICLE',
      payload: {
        url,
        forceRefresh: true,
        manualSelector: '',
        followTabs: false,
        sourceSettings: state.sourceSettings
      }
    });

    if (!response.ok) {
      throw new Error(response.error || '提取失败');
    }

    const hydrated = await hydrateFeishuPreviewAssets(response.data?.contentHtml || '');
    if (hydrated.failedTokens.length > 0) {
      throw new Error(`FEISHU_IMAGE_FETCH_FAILED: 有 ${hydrated.failedTokens.length} 张图片未拉取成功`);
    }

    const article = {
      ...(response.data || {}),
      sourceUrl: url,
      contentHtml: hydrated.html
    };
    state.article = article;
    applyArticle(article);
    setExtractStatus('提取成功，请检查内容后继续', article.validation?.ok ? 'success' : 'warn');
    setState(WORKBENCH_STATES.COPY_READY);
    await runPrepublishChecks();

    await appendRunHistory({
      type: 'extract',
      status: 'success',
      url,
      title: article.title || '',
      durationMs: Date.now() - startedAt,
      imageFailures: hydrated.failedTokens.length
    });
  } finally {
    setBusy(false);
    await persistWorkbenchSession();
  }
}

function applyArticle(article) {
  const title = String(article?.title || '').trim();
  const contentHtml = String(article?.contentHtml || '').trim();

  dom.titleInput.value = title;
  dom.contentPreview.innerHTML = contentHtml;
  dom.wordCount.textContent = String(article?.wordCount || 0);
  dom.imageCount.textContent = String(article?.imageCount || 0);
  dom.paragraphCount.textContent = String(article?.paragraphCount || 0);
  renderValidation(article?.validation, article?.validationHints || []);
}

async function copyAndOpenPublishPage() {
  const prepared = collectCurrentContent('none');
  if (!prepared.contentHtml) {
    throw new Error('CONTENT_MISSING: 请先提取并确认内容');
  }

  const publishHtml = buildFoodtalksPasteHtml(prepared.contentHtml);
  if (!publishHtml) {
    throw new Error('CONTENT_MISSING: 生成代码为空，请重新提取');
  }

  const imageCheck = validatePublishHtmlImages(publishHtml);
  if (imageCheck.invalidCount > 0) {
    throw new Error(`FEISHU_IMAGE_FETCH_FAILED: 仍有 ${imageCheck.invalidCount} 张图片未就绪，请重试提取`);
  }

  await copyTextToClipboard(publishHtml);

  await runtimeSend({
    type: 'START_FOODTALKS_LOGIN_FLOW',
    payload: {}
  }).then((response) => {
    if (!response.ok || !response.started) {
      throw new Error(response.error || 'FT_LOGIN_REQUIRED: 无法打开 FoodTalks 登录页');
    }
  });

  dom.publishProgressBar.style.width = '100%';
  dom.publishProgressText.textContent = '已复制正文代码，并在新标签页打开登录页';
  setState(WORKBENCH_STATES.PUBLISH_WAIT_LOGIN);
  setExtractStatus('已进入半自动流程：登录后在发布页手动确认并提交', 'success');

  await appendRunHistory({
    type: 'copy_open_login',
    status: 'success',
    url: prepared.sourceUrl,
    title: prepared.title,
    durationMs: 0,
    imageFailures: 0
  });

  await runPrepublishChecks();
}

async function openFoodtalksLogin() {
  const response = await runtimeSend({ type: 'START_FOODTALKS_LOGIN_FLOW', payload: {} });
  if (!response.ok || !response.started) {
    throw new Error(response.error || 'FT_LOGIN_REQUIRED: 无法打开登录页');
  }
  setExtractStatus('已打开 FoodTalks 登录页（新标签）', 'success');
  await runPrepublishChecks();
}

async function runAutoPublish(publishAction) {
  if (!['draft', 'publish'].includes(publishAction)) {
    return;
  }

  const content = collectCurrentContent(publishAction);
  if (!content.title) {
    throw new Error('CONTENT_MISSING: 标题不能为空');
  }
  if (!content.contentHtml) {
    throw new Error('CONTENT_MISSING: 正文不能为空');
  }

  setBusy(true);
  setState(WORKBENCH_STATES.REVIEW);
  dom.publishResultList.innerHTML = '';
  dom.publishProgressBar.style.width = '8%';
  dom.publishProgressText.textContent = publishAction === 'publish' ? '高级流程：自动发布中...' : '高级流程：自动保存草稿中...';
  const startedAt = Date.now();

  try {
    const response = await sendPublishContent({
      platformIds: ['foodtalks'],
      content,
      followTabs: true
    });

    if (!response.ok) {
      throw new Error(response.error || '同步失败');
    }

    renderPublishResults(response.results || []);
    const summary = response.summary || { total: 0, success: 0, failed: 0 };
    dom.publishProgressBar.style.width = '100%';
    dom.publishProgressText.textContent = `完成：成功 ${summary.success}/${summary.total}，失败 ${summary.failed}`;
    setState(summary.failed > 0 ? WORKBENCH_STATES.ERROR : WORKBENCH_STATES.DONE);

    await appendRunHistory({
      type: publishAction === 'publish' ? 'auto_publish' : 'auto_draft',
      status: summary.failed > 0 ? 'failed' : 'success',
      url: content.sourceUrl,
      title: content.title,
      durationMs: Date.now() - startedAt,
      imageFailures: 0
    });
  } finally {
    setBusy(false);
    await refreshLogs();
    await runPrepublishChecks();
  }
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
    }

    return runtimeSend({
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

function collectCurrentContent(publishAction = 'draft') {
  const sourceUrl = String(dom.urlInput?.value || '').trim();
  const title = String(dom.titleInput?.value || '').trim();
  const contentHtml = String(dom.contentPreview?.innerHTML || '').trim();

  return {
    title,
    sourceUrl,
    contentHtml,
    textPlain: stripHtml(contentHtml),
    images: extractImagesFromHtml(contentHtml),
    publishAction,
    preferImporter: false
  };
}

function extractImagesFromHtml(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html || '';
  return [...wrapper.querySelectorAll('img[src]')]
    .map((img, index) => ({
      index,
      src: img.getAttribute('src') || ''
    }))
    .filter((item) => item.src);
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function runPrepublishChecks() {
  const payload = {
    url: String(dom.urlInput?.value || '').trim(),
    sourceSettings: collectSourceSettings(),
    content: {
      ...(state.article || {}),
      title: String(dom.titleInput?.value || '').trim(),
      contentHtml: String(dom.contentPreview?.innerHTML || '').trim()
    }
  };

  const response = await runtimeSend({
    type: 'RUN_PREPUBLISH_CHECKS',
    payload
  });
  if (!response.ok) {
    throw new Error(response.error || '检查失败');
  }

  state.diagnostics = response.checks || [];
  renderDiagnostics(state.diagnostics);
}

function renderDiagnostics(checks = []) {
  dom.diagnosticsList.innerHTML = '';
  if (!checks.length) {
    const li = document.createElement('li');
    li.textContent = '暂无检查结果';
    dom.diagnosticsList.appendChild(li);
    return;
  }

  checks.forEach((item) => {
    const li = document.createElement('li');
    li.className = `ft-check ft-check-${item.status || 'warn'}`;
    li.innerHTML = `
      <div><strong>${escapeHtml(item.label || '检查项')}</strong></div>
      <div>${escapeHtml(item.message || '-')}</div>
      <div class="ft-check-meta">代码：${escapeHtml(item.code || '-')}</div>
    `;

    if (item.action?.type && item.action?.label) {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'btn btn-ghost';
      actionBtn.dataset.actionType = item.action.type;
      actionBtn.textContent = item.action.label;
      li.appendChild(actionBtn);
    }

    dom.diagnosticsList.appendChild(li);
  });
}

async function handleRecoveryAction(actionType) {
  switch (actionType) {
    case 'open_login':
      await openFoodtalksLogin();
      break;
    case 'focus_url':
      dom.urlInput?.focus();
      break;
    case 'open_credentials':
      dom.feishuAppIdInput?.focus();
      break;
    case 'reextract':
      await runExtraction();
      break;
    default:
      setExtractStatus('当前动作未定义，请按步骤重试', 'warn');
  }
}

function renderValidation(validation, hints = []) {
  const items = [];
  (validation?.missing || []).forEach((item) => items.push({ level: 'error', text: `缺失：${item}` }));
  (validation?.warnings || []).forEach((item) => items.push({ level: 'warn', text: item }));
  hints.forEach((item) => items.push({ level: 'warn', text: item }));

  if (!items.length) {
    items.push({ level: 'success', text: '完整性检查通过' });
  }

  dom.validationList.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = `ft-check ft-check-${item.level}`;
    li.textContent = item.text;
    dom.validationList.appendChild(li);
  });
}

async function hydrateFeishuPreviewAssets(contentHtml) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = contentHtml || '';
  const tokenNodeMap = new Map();
  const failedTokens = [];

  [...wrapper.querySelectorAll('img[data-feishu-token]')].forEach((node) => {
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
  for (const token of tokens) {
    const response = await runtimeSend({
      type: 'FETCH_FEISHU_IMAGE',
      payload: {
        mediaToken: token,
        sourceSettings: collectSourceSettings()
      }
    });

    if (!response.ok || !response.dataUrl) {
      failedTokens.push(token);
      continue;
    }

    const nodes = tokenNodeMap.get(token) || [];
    nodes.forEach((node) => {
      node.setAttribute('src', response.dataUrl);
      node.removeAttribute('data-feishu-token');
      node.removeAttribute('data-feishu-block-id');
    });
  }

  return {
    html: wrapper.innerHTML.trim(),
    failedTokens
  };
}

async function copyTextToClipboard(text) {
  const normalized = String(text || '');
  if (!normalized.trim()) {
    throw new Error('CONTENT_MISSING: 复制内容为空');
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(normalized);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = normalized;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) {
    throw new Error('浏览器不支持自动复制');
  }
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
    const platform = escapeHtml(result.platformName || result.platformId || 'FoodTalks');
    if (result.status === 'success') {
      li.className = 'ft-check ft-check-success';
      li.textContent = `${platform}：自动同步完成`;
    } else {
      li.className = 'ft-check ft-check-error';
      li.textContent = `${platform}：${result.error || '同步失败'}`;
    }
    dom.publishResultList.appendChild(li);
  });
}

function clearPublishResult() {
  dom.publishProgressBar.style.width = '0';
  dom.publishProgressText.textContent = '待执行';
  dom.publishResultList.innerHTML = '';
}

async function refreshLogs() {
  const response = await runtimeSend({ type: 'GET_LOGS' });
  if (!response.ok) {
    return;
  }
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
    li.textContent = `[${time}] [${log.stage || 'system'}] ${log.message || ''}`;
    if (log.level === 'error') li.className = 'ft-check ft-check-error';
    if (log.level === 'warn') li.className = 'ft-check ft-check-warn';
    dom.logList.appendChild(li);
  });
}

function setExtractStatus(message, tone = 'info') {
  dom.extractStatus.textContent = String(message || '');
  dom.extractStatus.dataset.tone = tone;
}

function setFeishuConfigStatus(message, tone = 'info') {
  dom.feishuConfigStatus.textContent = String(message || '');
  dom.feishuConfigStatus.dataset.tone = tone;
}

function renderError(error, fallbackState = WORKBENCH_STATES.ERROR) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const mapped = mapErrorToRecovery(rawMessage);
  setExtractStatus(`${mapped.code}：${mapped.message}。建议动作：${mapped.actionLabel}`, 'error');
  setState(fallbackState);
  appendRunHistory({
    type: 'error',
    status: 'failed',
    url: String(dom.urlInput?.value || '').trim(),
    title: String(dom.titleInput?.value || '').trim(),
    durationMs: 0,
    imageFailures: 0,
    errorCode: mapped.code
  }).catch(() => undefined);
}

function isFeishuDocUrl(url) {
  return /^https?:\/\/([a-z0-9-]+\.)?(feishu\.cn|larkoffice\.com)\/(?:docx|wiki)\/[a-z0-9]+/i.test(String(url || '').trim());
}

async function runtimeSend(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function restoreWorkbenchSession() {
  const store = await chrome.storage.local.get(WORKBENCH_SESSION_KEY);
  const session = store?.[WORKBENCH_SESSION_KEY];
  if (!session || typeof session !== 'object') {
    return;
  }

  if (typeof session.url === 'string' && session.url.trim()) {
    dom.urlInput.value = session.url.trim();
  }
  if (typeof session.title === 'string' && session.title.trim()) {
    dom.titleInput.value = session.title.trim();
  }
}

async function persistWorkbenchSession() {
  await chrome.storage.local.set({
    [WORKBENCH_SESSION_KEY]: {
      url: String(dom.urlInput?.value || '').trim(),
      title: String(dom.titleInput?.value || '').trim(),
      state: state.current,
      updatedAt: new Date().toISOString()
    }
  });
}

async function loadRunHistory() {
  const store = await chrome.storage.local.get(RUN_HISTORY_KEY);
  state.runHistory = Array.isArray(store?.[RUN_HISTORY_KEY]) ? store[RUN_HISTORY_KEY].slice(0, MAX_RUN_HISTORY) : [];
  renderRunHistory();
}

async function appendRunHistory(entry) {
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry
  };
  state.runHistory = [record, ...state.runHistory].slice(0, MAX_RUN_HISTORY);
  await chrome.storage.local.set({
    [RUN_HISTORY_KEY]: state.runHistory
  });
  renderRunHistory();
}

function renderRunHistory() {
  dom.runHistoryList.innerHTML = '';
  if (!state.runHistory.length) {
    const li = document.createElement('li');
    li.textContent = '暂无任务记录';
    dom.runHistoryList.appendChild(li);
    return;
  }

  state.runHistory.forEach((item) => {
    const li = document.createElement('li');
    const createdAt = new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false });
    li.innerHTML = `
      <div><strong>${escapeHtml(item.type || 'task')}</strong> · ${escapeHtml(item.status || '-')}</div>
      <div class="ft-check-meta">${escapeHtml(item.url || '-')}</div>
      <div class="ft-check-meta">${createdAt}</div>
    `;
    dom.runHistoryList.appendChild(li);
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
