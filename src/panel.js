import { buildFoodtalksPasteHtml, validatePublishHtmlImages } from './shared/foodtalks-html.js';
import { buildWechatPasteHtml } from './shared/wechat-html.js';
import {
  clampProgress,
  getActionButtonConfig,
  POPUP_MODES,
  shouldShowReextractButton,
  SYNC_TARGETS,
  WECHAT_SYNC_STATUSES
} from './shared/popup-flow.js';
import {
  getPopupExtractCacheKey,
  getPopupExtractUrlCacheKey,
  normalizeSourceUrlForCache
} from './shared/popup-extract-cache.js';
import {
  CONTENT_CHUNK_CHAR_SIZE,
  getWechatSyncTransferPlan,
  splitSerializedContentForTransfer
} from './shared/wechat-sync-transfer.js';

const PANEL_PARAMS = new URLSearchParams(window.location.search);
const PANEL_SOURCE_URL = String(PANEL_PARAMS.get('sourceUrl') || '').trim();
const PANEL_SOURCE_TAB_ID = Number(PANEL_PARAMS.get('sourceTabId') || 0);
const PANEL_FORCE_REFRESH = PANEL_PARAMS.get('forceRefresh') === '1';
const IMAGE_FETCH_CONCURRENCY = 2;
const EXTRACT_CACHE_MAX_BYTES = 800 * 1024;
const WECHAT_WORKER_REQUEST_PREPARE = 'PREPARE_WECHAT_SYNC_PAYLOAD';

const dom = {
  urlInput: document.getElementById('urlInput'),
  feishuAppIdInput: document.getElementById('feishuAppIdInput'),
  feishuAppSecretInput: document.getElementById('feishuAppSecretInput'),
  settingsToggle: document.getElementById('settingsToggle'),
  settingsPanel: document.getElementById('settingsPanel'),
  targetSection: document.getElementById('targetSection'),
  targetInputs: Array.from(document.querySelectorAll('input[name="syncTarget"]')),
  actionButton: document.getElementById('actionButton'),
  cacheInfoRow: document.getElementById('cacheInfoRow'),
  cacheTimeText: document.getElementById('cacheTimeText'),
  reextractButton: document.getElementById('reextractButton'),
  hintText: document.getElementById('hintText'),
  hintLead: document.getElementById('hintLead'),
  hintBody: document.getElementById('hintBody'),
  wechatStatusTag: document.getElementById('wechatStatusTag'),
  wechatStatusText: document.getElementById('wechatStatusText')
};

const state = {
  mode: POPUP_MODES.EXTRACT,
  target: '',
  pendingHtml: '',
  pendingFoodtalksHtml: '',
  pendingWechatHtml: '',
  pendingTitle: '',
  sourceTabId: null,
  cachedAt: null,
  loginOpened: false,
  progressValue: 0,
  progressTimer: null,
  wechatSyncSessionId: '',
  wechatSyncStatus: WECHAT_SYNC_STATUSES.IDLE,
  wechatSyncMessage: '',
  wechatSyncPollTimer: null,
  wechatFailureHandled: false
};

let wechatHtmlWorker = null;
let wechatHtmlWorkerRequestCursor = 0;
const wechatHtmlWorkerPending = new Map();

bootstrap().catch((error) => {
  setHint(error instanceof Error ? error.message : String(error), 'error');
});

async function bootstrap() {
  dom.actionButton?.addEventListener('click', onAction);
  dom.reextractButton?.addEventListener('click', onReextract);
  dom.urlInput?.addEventListener('input', onUrlInputChange);
  dom.settingsToggle?.addEventListener('click', toggleSettingsPanel);
  dom.targetInputs.forEach((input) => input.addEventListener('change', onTargetChange));
  window.addEventListener('beforeunload', onBeforeUnload);

  const [activeTab, settingsResponse] = await Promise.all([getActiveTabInfo(), runtimeSend({ type: 'GET_SOURCE_SETTINGS' })]);
  if (settingsResponse.ok) {
    dom.feishuAppIdInput.value = settingsResponse.settings?.feishuAppId || '';
    dom.feishuAppSecretInput.value = settingsResponse.settings?.feishuAppSecret || '';
  }

  if (activeTab?.url) {
    dom.urlInput.value = activeTab.url;
  }
  if (Number.isInteger(activeTab?.id) && activeTab.id > 0) {
    state.sourceTabId = activeTab.id;
  }
  if (PANEL_SOURCE_URL) {
    dom.urlInput.value = PANEL_SOURCE_URL;
  }
  if (Number.isInteger(PANEL_SOURCE_TAB_ID) && PANEL_SOURCE_TAB_ID > 0) {
    state.sourceTabId = PANEL_SOURCE_TAB_ID;
  }

  resetTargetSelection();
  renderWechatStatusTag();

  setMode(POPUP_MODES.EXTRACT);
  setProgress(0);

  if (PANEL_FORCE_REFRESH && PANEL_SOURCE_URL && isFeishuDocUrl(PANEL_SOURCE_URL)) {
    await runExtract();
    return;
  }

  const restored = await restoreExtractCacheIfAvailable();
  if (restored) {
    return;
  }

  if (PANEL_SOURCE_URL && isFeishuDocUrl(PANEL_SOURCE_URL)) {
    await runExtract();
    return;
  }

  if (isFeishuDocUrl(dom.urlInput.value.trim())) {
    setHintWithLead('已识别', '飞书文档，可点击提取', 'success');
  } else {
    setHintWithLead('未识别', '请先打开飞书文档', 'error');
  }
}

function onBeforeUnload() {
  stopWechatSyncPolling();
  disposeWechatHtmlWorker();
}

function onUrlInputChange() {
  if (state.mode !== POPUP_MODES.EXTRACT && state.mode !== POPUP_MODES.EXTRACTING) {
    cancelWechatSyncFlowIfNeeded().catch(() => undefined);
    stopWechatSyncPolling();
    state.pendingHtml = '';
    state.pendingFoodtalksHtml = '';
    state.pendingWechatHtml = '';
    state.pendingTitle = '';
    state.cachedAt = null;
    state.loginOpened = false;
    state.wechatSyncSessionId = '';
    state.wechatSyncStatus = WECHAT_SYNC_STATUSES.IDLE;
    state.wechatSyncMessage = '';
    state.wechatFailureHandled = false;
    resetTargetSelection();
    setMode(POPUP_MODES.EXTRACT);
    setProgress(0);
    setHint('链接已变更，请重新提取', 'info');
  }
}

function onTargetChange(event) {
  const nextTarget = event?.target?.value;
  if (nextTarget !== SYNC_TARGETS.FOODTALKS && nextTarget !== SYNC_TARGETS.WECHAT) {
    return;
  }

  state.target = nextTarget;
  if (state.mode === POPUP_MODES.COPIED && state.target !== SYNC_TARGETS.FOODTALKS) {
    state.mode = POPUP_MODES.SYNC;
  }
  if (state.target !== SYNC_TARGETS.WECHAT) {
    stopWechatSyncPolling();
  }
  renderWechatStatusTag();
  renderActionButton();
}

function toggleSettingsPanel() {
  const isHidden = dom.settingsPanel.classList.contains('is-hidden');
  dom.settingsPanel.classList.toggle('is-hidden', !isHidden);
  dom.settingsToggle?.setAttribute('aria-expanded', String(isHidden));
}

async function onAction() {
  if (state.mode === POPUP_MODES.EXTRACTING) {
    return;
  }

  if (state.mode === POPUP_MODES.EXTRACT) {
    await runExtract();
    return;
  }

  await runSyncAction();
}

async function onReextract() {
  if (state.mode === POPUP_MODES.EXTRACTING) {
    return;
  }
  await cancelWechatSyncFlowIfNeeded().catch(() => undefined);
  stopWechatSyncPolling();
  state.wechatSyncSessionId = '';
  state.wechatSyncStatus = WECHAT_SYNC_STATUSES.IDLE;
  state.wechatSyncMessage = '';
  state.wechatFailureHandled = false;
  resetTargetSelection();
  renderWechatStatusTag();
  await runExtract();
}

async function runExtract() {
  const url = String(dom.urlInput.value || '').trim();
  if (!url) {
    setHint('请先打开飞书文档页或粘贴链接', 'error');
    return;
  }
  if (!isFeishuDocUrl(url)) {
    setHint('仅支持飞书 docx/wiki 链接', 'error');
    return;
  }

  setMode(POPUP_MODES.EXTRACTING);
  setHint('提取中', 'info');
  startProgress();
  await cancelWechatSyncFlowIfNeeded().catch(() => undefined);
  stopWechatSyncPolling();
  const extractPerfStart = nowTimestamp();
  let extractApiMs = 0;
  let hydrateMs = 0;

  try {
    const sourceSettings = collectSourceSettings();
    await saveSourceSettings(sourceSettings);

    const extractApiStart = nowTimestamp();
    const extractResponse = await runtimeSend({
      type: 'EXTRACT_ARTICLE',
      payload: {
        url,
        forceRefresh: true,
        manualSelector: '',
        followTabs: false,
        sourceSettings,
        sourceTabId: state.sourceTabId
      }
    });
    extractApiMs = nowTimestamp() - extractApiStart;

    if (!extractResponse.ok) {
      throw new Error(formatExtractError(extractResponse.error || '提取失败'));
    }

    const rawContentHtml = String(extractResponse.data?.contentHtml || '').trim();
    if (!rawContentHtml) {
      throw new Error('提取结果为空');
    }

    let contentHtml = rawContentHtml;
    const hydrateStart = nowTimestamp();
    const hydration = await hydrateFeishuHtmlAssets(contentHtml, sourceSettings);
    hydrateMs = nowTimestamp() - hydrateStart;
    contentHtml = hydration.html;
    if (hydration.failedTokens.length > 0) {
      throw new Error(`有 ${hydration.failedTokens.length} 张图片拉取失败`);
    }

    const hydratedImageCheck = validatePublishHtmlImages(contentHtml);
    if (hydratedImageCheck.invalidCount > 0) {
      throw new Error(`有 ${hydratedImageCheck.invalidCount} 张图片未就绪`);
    }

    state.pendingHtml = contentHtml;
    state.pendingFoodtalksHtml = '';
    state.pendingWechatHtml = '';
    state.pendingTitle = String(extractResponse.data?.title || '').trim();
    state.cachedAt = Date.now();
    state.loginOpened = false;
    state.wechatSyncSessionId = '';
    state.wechatSyncStatus = WECHAT_SYNC_STATUSES.IDLE;
    state.wechatSyncMessage = '';
    state.wechatFailureHandled = false;
    resetTargetSelection();
    await persistExtractCache(url, {
      sourceHtml: contentHtml,
      title: state.pendingTitle
    }, state.cachedAt);
    dom.targetSection.classList.remove('is-hidden');
    finishProgress(true);
    setMode(POPUP_MODES.SYNC);
    setHint('请选择同步目标', 'success');
    reportPerfMetric('panel.extract', nowTimestamp() - extractPerfStart, {
      extractApiMs: Math.round(extractApiMs),
      hydrateMs: Math.round(hydrateMs),
      sourceBytes: byteLength(contentHtml),
      sourceUrl: url
    });
  } catch (error) {
    finishProgress(false);
    state.pendingHtml = '';
    state.pendingFoodtalksHtml = '';
    state.pendingWechatHtml = '';
    state.pendingTitle = '';
    state.cachedAt = null;
    state.wechatSyncSessionId = '';
    state.wechatSyncStatus = WECHAT_SYNC_STATUSES.IDLE;
    state.wechatSyncMessage = '';
    state.wechatFailureHandled = false;
    resetTargetSelection();
    dom.targetSection.classList.add('is-hidden');
    setMode(POPUP_MODES.EXTRACT);
    setHint(error instanceof Error ? error.message : String(error), 'error');
    reportPerfMetric('panel.extract.failed', nowTimestamp() - extractPerfStart, {
      extractApiMs: Math.round(extractApiMs),
      hydrateMs: Math.round(hydrateMs),
      sourceUrl: url
    });
  }
}

async function runSyncAction() {
  if (!state.pendingHtml) {
    setMode(POPUP_MODES.EXTRACT);
    dom.targetSection.classList.add('is-hidden');
    setHint('请先提取内容', 'error');
    return;
  }

  if (!state.target) {
    setHint('请选择同步目标', 'error');
    return;
  }

  if (state.target === SYNC_TARGETS.WECHAT) {
    try {
      const syncPerfStart = nowTimestamp();
      const prepareStart = nowTimestamp();
      const preparedPayload =
        (await prepareWechatSyncPayloadWithWorker({
          sourceHtml: state.pendingHtml,
          title: state.pendingTitle,
          templateId: ''
        })) ||
        prepareWechatSyncPayloadLocally({
          sourceHtml: state.pendingHtml,
          title: state.pendingTitle,
          templateId: ''
        });
      const prepareMs = nowTimestamp() - prepareStart;

      const wechatHtml = String(preparedPayload?.contentHtml || '').trim();
      if (!wechatHtml) {
        throw new Error('公众号正文生成失败');
      }

      const wechatImageCheck = validatePublishHtmlImages(wechatHtml);
      if (wechatImageCheck.invalidCount > 0) {
        throw new Error(`公众号有 ${wechatImageCheck.invalidCount} 张图片未就绪`);
      }

      const startFlowStart = nowTimestamp();
      const response = await startWechatSyncFlow({
        sourceUrl: String(dom.urlInput.value || '').trim(),
        sourceTabId: state.sourceTabId,
        title: state.pendingTitle,
        contentHtml: wechatHtml,
        templateId: ''
      }, preparedPayload);
      const startFlowMs = nowTimestamp() - startFlowStart;

      if (!response.ok || !response.sessionId) {
        throw new Error(response.error || '公众号同步启动失败');
      }

      state.wechatSyncSessionId = String(response.sessionId || '');
      state.wechatSyncStatus = String(response.status || WECHAT_SYNC_STATUSES.WAITING_LOGIN);
      state.wechatSyncMessage = '';
      state.wechatFailureHandled = false;
      // 会话已在后台持有完整 payload，释放前端副本降低内存峰值
      state.pendingWechatHtml = '';
      renderWechatStatusTag();
      renderActionButton();
      startWechatSyncPolling();
      setMode(POPUP_MODES.SYNC);
      setHint('公众号同步已启动，请按状态提示操作', 'info');
      reportPerfMetric('panel.wechat_sync.start', nowTimestamp() - syncPerfStart, {
        prepareMs: Math.round(prepareMs),
        startFlowMs: Math.round(startFlowMs),
        contentBytes: byteLength(wechatHtml),
        transferMode: preparedPayload?.transferPlan?.mode || 'direct',
        totalChunks: Number(preparedPayload?.transferPlan?.totalChunks || 0)
      });
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error), 'error');
    }
    return;
  }

  try {
    if (!state.pendingFoodtalksHtml) {
      const foodtalksHtml = buildFoodtalksPasteHtml(state.pendingHtml);
      if (!foodtalksHtml) {
        throw new Error('代码生成为空');
      }
      const imageCheck = validatePublishHtmlImages(foodtalksHtml);
      if (imageCheck.invalidCount > 0) {
        throw new Error(`有 ${imageCheck.invalidCount} 张图片未就绪`);
      }
      state.pendingFoodtalksHtml = foodtalksHtml;
    }

    await copyTextToClipboard(state.pendingFoodtalksHtml);
    setMode(POPUP_MODES.COPIED);
    setHint('已复制，可再次点击继续复制', 'success');

    if (!state.loginOpened && state.sourceTabId) {
      const response = await runtimeSend({
        type: 'START_FOODTALKS_LOGIN_FLOW',
        payload: {
          tabId: state.sourceTabId
        }
      });

      if (response.ok && response.started) {
        state.loginOpened = true;
      }
    }
  } catch (error) {
    setHint(error instanceof Error ? error.message : String(error), 'error');
  }
}

function setMode(mode) {
  state.mode = mode;

  if (mode === POPUP_MODES.EXTRACT) {
    dom.targetSection.classList.add('is-hidden');
  }
  const showRefreshActions = shouldShowReextractButton(mode);
  dom.cacheInfoRow.classList.toggle('is-hidden', !showRefreshActions);
  if (showRefreshActions) {
    renderCacheTimeText();
  }

  renderWechatStatusTag();
  renderActionButton();
}

function renderActionButton() {
  const config = getActionButtonConfig(state.mode, state.target, state.progressValue, {
    wechatSyncStatus: state.wechatSyncStatus
  });
  dom.actionButton.disabled = config.disabled;
  dom.actionButton.textContent = config.text;
  dom.actionButton.classList.remove('btn-primary', 'btn-secondary', 'btn-copied', 'btn-loading');
  String(config.className || '')
    .split(/\s+/)
    .filter(Boolean)
    .forEach((className) => dom.actionButton.classList.add(className));
  if (state.mode === POPUP_MODES.EXTRACTING) {
    dom.actionButton.style.setProperty('--btn-progress', `${state.progressValue}%`);
  } else {
    dom.actionButton.style.setProperty('--btn-progress', '0%');
  }
}

function setHint(message, tone = 'info') {
  const leadByTone = {
    success: '完成',
    error: '异常',
    info: '提示'
  };
  const lead = leadByTone[tone] || leadByTone.info;
  setHintWithLead(lead, message, tone);
}

function setHintWithLead(lead, message, tone = 'info') {
  dom.hintLead.textContent = String(lead || '');
  dom.hintBody.textContent = String(message || '');
  dom.hintText.dataset.tone = tone;
}

function resetTargetSelection() {
  state.target = '';
  dom.targetInputs.forEach((input) => {
    input.checked = false;
  });
}

function formatWechatStatusText(status) {
  switch (status) {
    case WECHAT_SYNC_STATUSES.WAITING_LOGIN:
      return '公众号状态：待登录';
    case WECHAT_SYNC_STATUSES.WAITING_EDITOR:
      return '公众号状态：待编辑页';
    case WECHAT_SYNC_STATUSES.FILLING:
      return '公众号状态：填充中';
    case WECHAT_SYNC_STATUSES.DONE:
      return '公众号状态：已完成';
    case WECHAT_SYNC_STATUSES.FAILED:
      return '公众号状态：失败';
    case WECHAT_SYNC_STATUSES.CANCELLED:
      return '公众号状态：已取消';
    default:
      return '公众号状态：待开始';
  }
}

function renderWechatStatusTag() {
  const shouldShow =
    state.target === SYNC_TARGETS.WECHAT &&
    (state.mode === POPUP_MODES.SYNC || state.mode === POPUP_MODES.COPIED);
  dom.wechatStatusTag.classList.toggle('is-hidden', !shouldShow);
  if (!shouldShow) {
    return;
  }

  dom.wechatStatusTag.dataset.status = String(state.wechatSyncStatus || WECHAT_SYNC_STATUSES.IDLE);
  dom.wechatStatusText.textContent = formatWechatStatusText(state.wechatSyncStatus);
}

function stopWechatSyncPolling() {
  if (!state.wechatSyncPollTimer) {
    return;
  }
  window.clearInterval(state.wechatSyncPollTimer);
  state.wechatSyncPollTimer = null;
}

function startWechatSyncPolling() {
  stopWechatSyncPolling();
  state.wechatSyncPollTimer = window.setInterval(() => {
    pollWechatSyncStatus().catch(() => undefined);
  }, 1200);
  pollWechatSyncStatus().catch(() => undefined);
}

function isWechatPendingStatus(status) {
  return (
    status === WECHAT_SYNC_STATUSES.WAITING_LOGIN ||
    status === WECHAT_SYNC_STATUSES.WAITING_EDITOR ||
    status === WECHAT_SYNC_STATUSES.FILLING
  );
}

function formatWechatApplyMethod(method) {
  const normalized = String(method || '').trim();
  if (!normalized) return '';
  if (normalized === 'mp_editor_jsapi') return 'JSAPI';
  if (normalized === 'prosemirror_paste') return '粘贴填充';
  if (normalized === 'ueditor') return 'UEditor';
  if (normalized === 'iframe') return 'Iframe';
  if (normalized === 'dom') return 'DOM';
  return normalized;
}

async function pollWechatSyncStatus() {
  if (!state.wechatSyncSessionId) {
    stopWechatSyncPolling();
    return;
  }

  const response = await runtimeSend({
    type: 'CHECK_WECHAT_SYNC_STATUS',
    payload: {
      sessionId: state.wechatSyncSessionId
    }
  });

  if (!response.ok) {
    stopWechatSyncPolling();
    state.wechatSyncStatus = WECHAT_SYNC_STATUSES.FAILED;
    state.wechatSyncMessage = response.error || '公众号状态检测失败';
    renderWechatStatusTag();
    renderActionButton();
    setHint(state.wechatSyncMessage, 'error');
    return;
  }

  const status = String(response.status || WECHAT_SYNC_STATUSES.IDLE);
  const message = String(response.message || '').trim();
  const previous = state.wechatSyncStatus;
  state.wechatSyncStatus = status;
  state.wechatSyncMessage = message;
  renderWechatStatusTag();
  renderActionButton();

  if (isWechatPendingStatus(status)) {
    if (status !== previous) {
      const pendingMessageByStatus = {
        [WECHAT_SYNC_STATUSES.WAITING_LOGIN]: message || '请在公众号后台登录账号',
        [WECHAT_SYNC_STATUSES.WAITING_EDITOR]: message || '已登录，等待进入图文编辑页',
        [WECHAT_SYNC_STATUSES.FILLING]: message || '正在自动填充标题和正文'
      };
      setHint(pendingMessageByStatus[status] || '公众号同步进行中', 'info');
    }
    return;
  }

  stopWechatSyncPolling();
  if (status === WECHAT_SYNC_STATUSES.DONE) {
    const applyMethod = formatWechatApplyMethod(response.detail?.applyMethod);
    const detailSuffix = applyMethod ? `（方式：${applyMethod}）` : '';
    setHint((message || '公众号标题与正文已自动填充完成') + detailSuffix, 'success');
    return;
  }

  if (status === WECHAT_SYNC_STATUSES.FAILED) {
    const errorCode = String(response.code || '').trim();
    const errorPrefix = errorCode ? `[${errorCode}] ` : '';
    if (!state.wechatFailureHandled && state.pendingWechatHtml) {
      try {
        await copyTextToClipboard(state.pendingWechatHtml, { asHtml: true });
        state.wechatFailureHandled = true;
        setHint(`${errorPrefix}公众号自动填充失败，已复制 HTML 正文，请手动粘贴`, 'error');
      } catch {
        setHint(errorPrefix + (message || '公众号自动填充失败，请手动复制正文'), 'error');
      }
      return;
    }

    if (!state.wechatFailureHandled && !state.pendingWechatHtml && state.pendingHtml) {
      try {
        const rebuiltWechatHtml = buildWechatPasteHtml(state.pendingHtml);
        if (rebuiltWechatHtml) {
          await copyTextToClipboard(rebuiltWechatHtml, { asHtml: true });
          state.wechatFailureHandled = true;
          setHint(`${errorPrefix}公众号自动填充失败，已复制 HTML 正文，请手动粘贴`, 'error');
          return;
        }
      } catch {
        // ignore and fallback to normal error hint
      }
    }

    setHint(errorPrefix + (message || '公众号自动填充失败，请重试'), 'error');
    return;
  }

  if (status === WECHAT_SYNC_STATUSES.CANCELLED) {
    setHint(message || '公众号同步已取消', 'info');
    return;
  }
}

async function cancelWechatSyncFlowIfNeeded() {
  if (!state.wechatSyncSessionId) {
    return;
  }

  await runtimeSend({
    type: 'CANCEL_WECHAT_SYNC_FLOW',
    payload: {
      sessionId: state.wechatSyncSessionId
    }
  });
}

async function restoreExtractCacheIfAvailable() {
  const currentUrl = normalizeSourceUrlForCache(dom.urlInput.value);
  if (!currentUrl) {
    return false;
  }

  try {
    const tabCacheKey = getPopupExtractCacheKey(state.sourceTabId);
    if (tabCacheKey) {
      const storeByTab = await chrome.storage.local.get(tabCacheKey);
      const hitByTab = applyCachedEntry(storeByTab?.[tabCacheKey], currentUrl);
      if (hitByTab) {
        return true;
      }
    }

    const urlCacheKey = getPopupExtractUrlCacheKey(currentUrl);
    if (!urlCacheKey) {
      return false;
    }
    const storeByUrl = await chrome.storage.local.get(urlCacheKey);
    return applyCachedEntry(storeByUrl?.[urlCacheKey], currentUrl);
  } catch {
    return false;
  }
}

async function persistExtractCache(sourceUrl, cachePayload, updatedAt = Date.now()) {
  const tabCacheKey = getPopupExtractCacheKey(state.sourceTabId);
  const urlCacheKey = getPopupExtractUrlCacheKey(sourceUrl);
  if (!tabCacheKey && !urlCacheKey) return;

  const cachedSourceHtml = String(cachePayload?.sourceHtml || cachePayload?.html || '').trim();
  const cachedTitle = String(cachePayload?.title || '').trim();
  if (!cachedSourceHtml) {
    return;
  }

  const sourceBytes = new TextEncoder().encode(cachedSourceHtml).length;
  if (sourceBytes > EXTRACT_CACHE_MAX_BYTES) {
    return;
  }

  try {
    const payload = {
      sourceUrl: String(sourceUrl || '').trim(),
      sourceHtml: cachedSourceHtml,
      title: cachedTitle,
      updatedAt: Number(updatedAt) || Date.now()
    };
    const storePatch = {};
    if (tabCacheKey) storePatch[tabCacheKey] = payload;
    if (urlCacheKey) storePatch[urlCacheKey] = payload;
    await chrome.storage.local.set(storePatch);
  } catch {
    // ignore storage write failures for cache path
  }
}

function applyCachedEntry(cached, currentUrl) {
  const cachedSourceHtml = String(cached?.sourceHtml || '').trim();
  const cachedFoodtalksHtml = String(cached?.foodtalksHtml || cached?.html || '').trim();
  const cachedWechatHtml = String(cached?.wechatHtml || '').trim();
  const fallbackSourceHtml = cachedSourceHtml || cachedWechatHtml || cachedFoodtalksHtml;
  if (!fallbackSourceHtml) {
    return false;
  }

  const cachedSourceUrl = normalizeSourceUrlForCache(cached?.sourceUrl);
  if (currentUrl && cachedSourceUrl && currentUrl !== cachedSourceUrl) {
    return false;
  }

  state.pendingHtml = fallbackSourceHtml;
  state.pendingFoodtalksHtml = cachedSourceHtml ? '' : cachedFoodtalksHtml;
  state.pendingWechatHtml = cachedSourceHtml ? '' : cachedWechatHtml;
  state.pendingTitle = String(cached?.title || '').trim();
  state.cachedAt = Number(cached?.updatedAt) || null;
  state.loginOpened = false;
  state.wechatSyncSessionId = '';
  state.wechatSyncStatus = WECHAT_SYNC_STATUSES.IDLE;
  state.wechatSyncMessage = '';
  state.wechatFailureHandled = false;
  resetTargetSelection();
  dom.targetSection.classList.remove('is-hidden');
  setMode(POPUP_MODES.SYNC);
  setHintWithLead('已缓存', '提取结果，可直接同步', 'success');
  return true;
}

function renderCacheTimeText() {
  dom.cacheTimeText.textContent = formatCacheTimeText(state.cachedAt);
}

function formatCacheTimeText(timestamp) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '缓存时间：刚刚';
  }

  const cachedDate = new Date(numeric);
  if (Number.isNaN(cachedDate.getTime())) {
    return '缓存时间：刚刚';
  }

  const now = new Date();
  const timePart = cachedDate.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const isSameDay =
    cachedDate.getFullYear() === now.getFullYear() &&
    cachedDate.getMonth() === now.getMonth() &&
    cachedDate.getDate() === now.getDate();

  if (isSameDay) {
    return `缓存时间：${timePart}`;
  }

  return `缓存时间：${cachedDate.getMonth() + 1}/${cachedDate.getDate()} ${timePart}`;
}

function setProgress(percent) {
  state.progressValue = clampProgress(percent);
  if (state.mode === POPUP_MODES.EXTRACTING) {
    renderActionButton();
  } else {
    dom.actionButton.style.setProperty('--btn-progress', '0%');
  }
}

function startProgress() {
  stopProgressTimer();
  setProgress(2);
  state.progressTimer = window.setInterval(() => {
    const step = Math.max(1, Math.round(Math.random() * 6));
    const next = Math.min(93, state.progressValue + step);
    setProgress(next);
  }, 170);
}

function finishProgress(success) {
  stopProgressTimer();
  if (success) {
    setProgress(100);
    return;
  }

  setProgress(100);
  window.setTimeout(() => {
    setProgress(0);
  }, 260);
}

function stopProgressTimer() {
  if (!state.progressTimer) {
    return;
  }
  window.clearInterval(state.progressTimer);
  state.progressTimer = null;
}

function collectSourceSettings() {
  return {
    feishuAppId: String(dom.feishuAppIdInput.value || '').trim(),
    feishuAppSecret: String(dom.feishuAppSecretInput.value || '').trim()
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
    return '提取失败';
  }

  if (
    /读取失败：请先在该飞书文档中添加应用/.test(message) ||
    /(forbidden|permission|权限|无权限|未授权|not authorized|code=177003|code=91403|code=99991663)/i.test(message)
  ) {
    return '无权限读取文档，请先为应用授权';
  }

  return message;
}

async function getActiveTabInfo() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0] || null;
  return {
    id: Number(tab?.id || 0),
    url: String(tab?.url || '').trim()
  };
}

async function startWechatSyncFlow(payload = {}, transferOptions = null) {
  const normalizedPayload = {
    sourceUrl: String(payload?.sourceUrl || '').trim(),
    sourceTabId: Number(payload?.sourceTabId || 0) || null,
    title: String(payload?.title || '').trim(),
    contentHtml: String(payload?.contentHtml || '').trim(),
    templateId: String(payload?.templateId || '').trim()
  };

  let serializedContent = '';
  const getSerializedContent = () => {
    if (serializedContent) {
      return serializedContent;
    }
    serializedContent =
      typeof transferOptions?.serializedContent === 'string' && transferOptions.serializedContent
        ? transferOptions.serializedContent
        : JSON.stringify({
            title: normalizedPayload.title,
            contentHtml: normalizedPayload.contentHtml,
            templateId: normalizedPayload.templateId
          });
    return serializedContent;
  };

  const transferPlan =
    transferOptions?.transferPlan && typeof transferOptions.transferPlan === 'object'
      ? transferOptions.transferPlan
      : getWechatSyncTransferPlan(getSerializedContent());

  if (transferPlan.mode === 'direct') {
    return runtimeSend({
      type: 'START_WECHAT_SYNC_FLOW',
      payload: normalizedPayload
    });
  }

  const transferId = `wechat_sync_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const preparedChunks =
    Array.isArray(transferOptions?.chunks) && transferOptions.chunks.length
      ? transferOptions.chunks.map((chunk) => String(chunk || ''))
      : splitSerializedContentForTransfer(getSerializedContent(), { chunkCharSize: CONTENT_CHUNK_CHAR_SIZE });
  const totalChunks = preparedChunks.length || Number(transferPlan.totalChunks || 0);
  if (!Number.isFinite(totalChunks) || totalChunks < 1) {
    return { ok: false, error: '公众号同步分片生成失败，请重试' };
  }
  const beginResult = await runtimeSend({
    type: 'BEGIN_CONTENT_TRANSFER',
    payload: {
      transferId,
      totalChunks,
      contentSize: transferPlan.contentBytes
    }
  });
  if (!beginResult.ok) {
    return beginResult;
  }

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = String(preparedChunks[index] || '');
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

      if (index % 2 === 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return runtimeSend({
      type: 'START_WECHAT_SYNC_FLOW',
      payload: {
        sourceUrl: normalizedPayload.sourceUrl,
        sourceTabId: normalizedPayload.sourceTabId,
        templateId: normalizedPayload.templateId,
        contentTransferId: transferId
      }
    });
  } finally {
    await runtimeSend({
      type: 'CLEAR_CONTENT_TRANSFER',
      payload: { transferId }
    });
  }
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

function nowTimestamp() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function byteLength(text) {
  return new TextEncoder().encode(String(text || '')).length;
}

function roundDuration(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function normalizeWechatTransferPayload(payload = {}) {
  const title = String(payload?.title || '').trim();
  const contentHtml = String(payload?.contentHtml || '').trim();
  const templateId = String(payload?.templateId || '').trim();
  const serializedContent = JSON.stringify({
    title,
    contentHtml,
    templateId
  });
  const transferPlan = getWechatSyncTransferPlan(serializedContent);

  return {
    title,
    contentHtml,
    templateId,
    serializedContent: transferPlan.mode === 'direct' ? serializedContent : '',
    transferPlan,
    chunks:
      transferPlan.mode === 'chunked'
        ? splitSerializedContentForTransfer(serializedContent, { chunkCharSize: CONTENT_CHUNK_CHAR_SIZE })
        : []
  };
}

function getWechatHtmlWorker() {
  if (wechatHtmlWorker) {
    return wechatHtmlWorker;
  }

  if (typeof Worker !== 'function') {
    return null;
  }

  try {
    const worker = new Worker(chrome.runtime.getURL('src/workers/wechat-html.worker.js'), {
      type: 'module'
    });
    worker.addEventListener('message', (event) => {
      const requestId = String(event?.data?.requestId || '').trim();
      if (!requestId) {
        return;
      }
      const pending = wechatHtmlWorkerPending.get(requestId);
      if (!pending) {
        return;
      }

      wechatHtmlWorkerPending.delete(requestId);
      if (event?.data?.ok) {
        pending.resolve(event.data.result || null);
      } else {
        pending.reject(new Error(String(event?.data?.error || 'Worker 执行失败')));
      }
    });
    worker.addEventListener('error', (event) => {
      const message = event?.message || 'Worker 执行失败';
      [...wechatHtmlWorkerPending.values()].forEach((pending) => {
        pending.reject(new Error(message));
      });
      wechatHtmlWorkerPending.clear();
      worker.terminate();
      if (wechatHtmlWorker === worker) {
        wechatHtmlWorker = null;
      }
    });
    wechatHtmlWorker = worker;
    return wechatHtmlWorker;
  } catch {
    wechatHtmlWorker = null;
    return null;
  }
}

function disposeWechatHtmlWorker() {
  if (!wechatHtmlWorker) {
    return;
  }

  try {
    wechatHtmlWorker.terminate();
  } catch {
    // ignore
  }
  wechatHtmlWorker = null;

  [...wechatHtmlWorkerPending.values()].forEach((pending) => {
    pending.reject(new Error('Worker 已关闭'));
  });
  wechatHtmlWorkerPending.clear();
}

async function requestWechatHtmlWorker(type, payload = {}) {
  const worker = getWechatHtmlWorker();
  if (!worker) {
    return null;
  }

  wechatHtmlWorkerRequestCursor += 1;
  const requestId = `wechat_worker_${Date.now()}_${wechatHtmlWorkerRequestCursor}`;
  return new Promise((resolve, reject) => {
    wechatHtmlWorkerPending.set(requestId, { resolve, reject });
    worker.postMessage({
      requestId,
      type,
      payload
    });
  });
}

async function prepareWechatSyncPayloadWithWorker(payload = {}) {
  try {
    const result = await requestWechatHtmlWorker(WECHAT_WORKER_REQUEST_PREPARE, payload);
    if (!result || typeof result !== 'object') {
      return null;
    }
    return {
      title: String(result?.title || '').trim(),
      contentHtml: String(result?.contentHtml || '').trim(),
      templateId: String(result?.templateId || '').trim(),
      serializedContent: String(result?.serializedContent || ''),
      transferPlan: result?.transferPlan && typeof result.transferPlan === 'object' ? result.transferPlan : null,
      chunks: Array.isArray(result?.chunks) ? result.chunks.map((chunk) => String(chunk || '')) : []
    };
  } catch {
    return null;
  }
}

function prepareWechatSyncPayloadLocally(payload = {}) {
  const sourceHtml = String(payload?.sourceHtml || '').trim();
  if (!sourceHtml) {
    return null;
  }

  const contentHtml = buildWechatPasteHtml(sourceHtml, {
    templateId: String(payload?.templateId || '').trim()
  });
  if (!contentHtml) {
    return null;
  }

  return normalizeWechatTransferPayload({
    title: String(payload?.title || '').trim(),
    contentHtml,
    templateId: String(payload?.templateId || '').trim()
  });
}

function reportPerfMetric(name, durationMs, detail = {}) {
  const normalizedName = String(name || '').trim();
  const normalizedDuration = roundDuration(durationMs);
  if (!normalizedName || normalizedDuration < 100) {
    return;
  }

  runtimeSend({
    type: 'REPORT_PERF_METRIC',
    payload: {
      source: 'panel',
      name: normalizedName,
      durationMs: normalizedDuration,
      detail
    }
  }).catch(() => undefined);
}

async function forEachWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;

  const size = Math.max(1, Number(concurrency) || 1);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(size, list.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) {
        break;
      }
      await worker(list[index], index);
    }
  });

  await Promise.all(runners);
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
  await forEachWithConcurrency(tokens, IMAGE_FETCH_CONCURRENCY, async (token, index) => {
    const response = await runtimeSend({
      type: 'FETCH_FEISHU_IMAGE',
      payload: {
        mediaToken: token,
        sourceSettings
      }
    });

    if (!response.ok || !response.dataUrl) {
      failedTokens.push(token);
      return;
    }

    const boundNodes = tokenNodeMap.get(token) || [];
    boundNodes.forEach((node) => {
      node.setAttribute('src', response.dataUrl);
      node.removeAttribute('data-feishu-token');
      node.removeAttribute('data-feishu-block-id');
    });

    if (index % 2 === 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  return {
    html: wrapper.innerHTML.trim(),
    failedTokens
  };
}

function stripHtmlForClipboard(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = String(html || '');
  return String(wrapper.textContent || wrapper.innerText || '').trim();
}

async function copyTextToClipboard(text, options = {}) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    throw new Error('复制内容为空');
  }

  if (options?.asHtml && navigator.clipboard?.write && typeof ClipboardItem === 'function') {
    const plainText = stripHtmlForClipboard(normalized) || normalized;
    const htmlBlob = new Blob([normalized], { type: 'text/html' });
    const textBlob = new Blob([plainText], { type: 'text/plain' });
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': htmlBlob,
        'text/plain': textBlob
      })
    ]);
    return;
  }

  if (navigator.clipboard?.writeText) {
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
