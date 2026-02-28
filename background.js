import { PLATFORM_ADAPTER_MAP } from './src/publishers/index.js';
import {
  downloadFeishuImageAsDataUrl,
  extractFeishuDocByApi,
  isFeishuDocUrl
} from './src/sources/feishu/extractor.js';
import {
  FOODTALKS_LOGIN_URL,
  FOODTALKS_PUBLISH_URL,
  isFoodtalksLoginUrl,
  isFoodtalksPublishUrl,
  shouldRedirectToFoodtalksPublish
} from './src/publishers/shared/foodtalks-urls.js';
import {
  WECHAT_MP_HOME_URL,
  buildWechatEditorUrl,
  getWechatMpToken,
  isWechatEditorUrl,
  isWechatMpUrl
} from './src/publishers/shared/wechat-urls.js';
import {
  buildImageTextRunSignature
} from './src/shared/wechat-editor-order.js';
import { buildWechatPasteHtml } from './src/shared/wechat-html.js';
import { extractWechatSyncTransferPayload } from './src/shared/wechat-sync-payload.js';
import {
  autoFillWechatEditorInPage,
  extractFeishuDocInPage,
  extractWechatArticleInPage
} from './src/background/injected/page-scripts.js';
import { createContentTransferService } from './src/background/content-transfer-service.js';
import { getPopupExtractCacheKey, getPopupExtractUrlCacheKey } from './src/shared/popup-extract-cache.js';

const FALLBACK_PAGE_URL = chrome.runtime.getURL('fallback.html');

const LOG_KEY = 'fbif_logs_v1';
const CACHE_KEY = 'fbif_cache_v1';
const FAILED_DRAFT_KEY = 'fbif_failed_drafts_v1';
const SOURCE_SETTINGS_KEY = 'fbif_source_settings_v1';
const WECHAT_SYNC_SESSION_KEY = 'fbif_wechat_sync_session_v1';
const WECHAT_TEMPLATE_REGISTRY_KEY = 'fbif_wechat_template_registry_v1';

const EXTRACTION_TIMEOUT_MS = 45_000;
const TAB_LOAD_TIMEOUT_MS = 35_000;
const EXTRACTION_RETRY_LIMIT = 2;
const PUBLISH_RETRY_LIMIT = 2;
const LOGIN_WAIT_TIMEOUT_MS = 180_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ITEMS = 20;
const MAX_LOG_ITEMS = 400;
const MAX_FAILED_DRAFTS = 50;
const MAX_FEISHU_IMAGE_CACHE_ITEMS = 80;
const FEISHU_IMAGE_FETCH_RETRY_LIMIT = 8;
const FEISHU_IMAGE_FETCH_RETRY_BASE_DELAY_MS = 900;
const CONTENT_TRANSFER_TTL_MS = 10 * 60 * 1000;
const MAX_CONTENT_TRANSFERS = 8;
const WECHAT_SYNC_TTL_MS = 30 * 60 * 1000;
const WECHAT_FILL_MIN_CONTENT_LENGTH = 20;
const DEFAULT_FEISHU_APP_ID = 'cli_a9f7f8703778dcee';
const DEFAULT_FEISHU_APP_SECRET = 'iqMX8dolH5aObUzgM18MQbtWvtfwKymM';

const feishuImageDataUrlCache = new Map();
const foodtalksLoginFlowByTabId = new Map();
const wechatSyncFillLocks = new Set();
const wechatSyncPayloadStore = new Map();
let wechatSyncSessionCache = null;
let wechatSyncSessionLoaded = false;
const contentTransferService = createContentTransferService({
  ttlMs: CONTENT_TRANSFER_TTL_MS,
  maxTransfers: MAX_CONTENT_TRANSFERS
});

const PLATFORMS = Object.fromEntries(
  Object.values(PLATFORM_ADAPTER_MAP).map((adapter) => [
    adapter.id,
    {
      id: adapter.id,
      name: adapter.name,
      publishUrl: adapter.publishUrl
    }
  ])
);

chrome.runtime.onInstalled.addListener(() => {
  appendLog('info', 'system', '扩展已安装，点击工具栏图标可打开提取弹窗').catch(() => undefined);
  ensureWechatTemplateRegistry().catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  handleFoodtalksLoginFlowTabUpdated(tabId, changeInfo, tab).catch(() => undefined);
  handleWechatSyncTabUpdated(tabId, changeInfo, tab).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (foodtalksLoginFlowByTabId.has(tabId)) {
    foodtalksLoginFlowByTabId.delete(tabId);
  }

  handleWechatSyncTabRemoved(tabId).catch(() => undefined);

  const popupCacheKey = getPopupExtractCacheKey(tabId);
  if (!popupCacheKey) return;

  (async () => {
    try {
      const store = await chrome.storage.local.get(popupCacheKey);
      const cached = store?.[popupCacheKey];
      const removeKeys = [popupCacheKey];

      const urlCacheKey = getPopupExtractUrlCacheKey(cached?.sourceUrl);
      if (urlCacheKey) {
        removeKeys.push(urlCacheKey);
      }

      await chrome.storage.local.remove(removeKeys);
    } catch {
      await chrome.storage.local.remove(popupCacheKey).catch(() => undefined);
    }
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});

async function handleRuntimeMessage(message, sender) {
  switch (message?.type) {
    case 'EXTRACT_ARTICLE': {
      const data = await extractArticle({
        ...(message?.payload ?? {}),
        sourceTabId: Number(message?.payload?.sourceTabId || sender?.tab?.id || 0) || null
      });
      return { data };
    }
    case 'PUBLISH_CONTENT': {
      return await publishContent({
        ...(message?.payload ?? {}),
        sourceTabId: Number(message?.payload?.sourceTabId || sender?.tab?.id || 0) || null
      });
    }
    case 'BEGIN_CONTENT_TRANSFER': {
      const transfer = contentTransferService.beginContentTransfer(message?.payload || {});
      return transfer;
    }
    case 'APPEND_CONTENT_CHUNK': {
      return contentTransferService.appendContentChunk(message?.payload || {});
    }
    case 'CLEAR_CONTENT_TRANSFER': {
      contentTransferService.clearContentTransfer(message?.payload?.transferId);
      return { cleared: true };
    }
    case 'GET_LOGS': {
      const logs = await readLogs();
      return { logs };
    }
    case 'CLEAR_LOGS': {
      await chrome.storage.local.set({ [LOG_KEY]: [] });
      return { cleared: true };
    }
    case 'GET_FAILED_DRAFTS': {
      return { drafts: await readFailedDrafts() };
    }
    case 'GET_SOURCE_SETTINGS': {
      return { settings: await getSourceSettings() };
    }
    case 'SAVE_SOURCE_SETTINGS': {
      const settings = await saveSourceSettings(message?.payload || {});
      return { settings };
    }
    case 'START_FOODTALKS_LOGIN_FLOW': {
      return await startFoodtalksLoginFlow(message?.payload || {}, sender);
    }
    case 'START_WECHAT_SYNC_FLOW': {
      return await startWechatSyncFlow(message?.payload || {}, sender);
    }
    case 'CHECK_WECHAT_SYNC_STATUS': {
      return await checkWechatSyncStatus(message?.payload || {});
    }
    case 'REPORT_PERF_METRIC': {
      return await reportPerfMetric(message?.payload || {});
    }
    case 'CANCEL_WECHAT_SYNC_FLOW': {
      return await cancelWechatSyncFlow(message?.payload || {});
    }
    case 'CHECK_FOODTALKS_LOGIN_STATUS': {
      return await checkFoodtalksLoginStatus();
    }
    case 'RUN_PREPUBLISH_CHECKS': {
      return await runPrepublishChecks(message?.payload || {});
    }
    case 'FETCH_FEISHU_IMAGE': {
      const data = await fetchFeishuImageDataUrl(message?.payload || {});
      return data;
    }
    default:
      throw new Error('不支持的消息类型');
  }
}

async function startFoodtalksLoginFlow(payload = {}, sender) {
  const sourceTabId = Number(payload?.tabId || sender?.tab?.id || 0);
  if (!Number.isInteger(sourceTabId) || sourceTabId <= 0) {
    throw new Error('未找到可跳转的当前标签页');
  }

  const sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
  if (!sourceTab?.id) {
    throw new Error('当前标签页不可用，请重试');
  }

  const loginTab = await chrome.tabs.create({
    url: FOODTALKS_LOGIN_URL,
    active: true,
    windowId: sourceTab.windowId
  });
  if (!loginTab?.id) {
    throw new Error('无法打开 FoodTalks 登录页');
  }

  foodtalksLoginFlowByTabId.set(loginTab.id, {
    createdAt: Date.now(),
    sourceTabId
  });

  return {
    started: true,
    tabId: loginTab.id,
    sourceTabId,
    loginUrl: FOODTALKS_LOGIN_URL
  };
}

async function checkFoodtalksLoginStatus() {
  const tabs = await chrome.tabs.query({ url: ['https://admin-we.foodtalks.cn/*'] });
  const matchedTab = tabs.find((item) => {
    const url = String(item?.url || '');
    return isFoodtalksPublishUrl(url) || shouldRedirectToFoodtalksPublish(url);
  });

  return {
    loggedIn: Boolean(matchedTab?.id),
    tabId: matchedTab?.id || null,
    loginUrl: FOODTALKS_LOGIN_URL,
    publishUrl: FOODTALKS_PUBLISH_URL
  };
}

const WECHAT_SYNC_STATUS = Object.freeze({
  IDLE: 'idle',
  WAITING_LOGIN: 'waiting_login',
  WAITING_EDITOR: 'waiting_editor',
  FILLING: 'filling',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

function isWechatSyncTerminalStatus(status) {
  return (
    status === WECHAT_SYNC_STATUS.DONE ||
    status === WECHAT_SYNC_STATUS.FAILED ||
    status === WECHAT_SYNC_STATUS.CANCELLED
  );
}

function normalizeWechatSyncErrorCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (
    normalized === 'WX_LOGIN_REQUIRED' ||
    normalized === 'WX_EDITOR_NOT_FOUND' ||
    normalized === 'WX_FILL_TITLE_FAILED' ||
    normalized === 'WX_FILL_CONTENT_FAILED'
  ) {
    return normalized;
  }
  return 'WX_UNKNOWN';
}

function generateWechatSessionId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `wxsync_${Date.now()}_${random}`;
}

function normalizeWechatSyncPayload(payload = {}) {
  return {
    sourceUrl: String(payload?.sourceUrl || '').trim(),
    sourceTabId: Number(payload?.sourceTabId || payload?.tabId || 0) || null,
    title: String(payload?.title || '').trim(),
    contentHtml: String(payload?.contentHtml || '').trim(),
    templateId: String(payload?.templateId || '').trim(),
    contentTransferId: String(payload?.contentTransferId || '').trim()
  };
}

function cleanupWechatSyncPayloadStore() {
  const now = Date.now();
  for (const [sessionId, payload] of wechatSyncPayloadStore.entries()) {
    if (!sessionId || !payload || Number(payload.expiresAt || 0) <= now) {
      wechatSyncPayloadStore.delete(sessionId);
    }
  }
}

function setWechatSyncPayload(sessionId, payload = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return;
  }

  cleanupWechatSyncPayloadStore();

  const title = String(payload?.title || '').trim();
  const contentHtml = String(payload?.contentHtml || '').trim();
  const templateId = String(payload?.templateId || '').trim();
  const expiresAt =
    Number(payload?.expiresAt) > 0
      ? Number(payload.expiresAt)
      : Date.now() + WECHAT_SYNC_TTL_MS;

  wechatSyncPayloadStore.set(normalizedSessionId, {
    title,
    contentHtml,
    templateId,
    expiresAt
  });
}

function getWechatSyncPayload(sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return null;
  }

  cleanupWechatSyncPayloadStore();
  const payload = wechatSyncPayloadStore.get(normalizedSessionId);
  if (!payload) {
    return null;
  }

  return {
    title: String(payload.title || '').trim(),
    contentHtml: String(payload.contentHtml || '').trim(),
    templateId: String(payload.templateId || '').trim()
  };
}

function clearWechatSyncPayload(sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return;
  }
  wechatSyncPayloadStore.delete(normalizedSessionId);
}

function sanitizeWechatSyncSession(raw = {}) {
  const now = Date.now();
  const createdAt = Number(raw?.createdAt) > 0 ? Number(raw.createdAt) : now;
  const updatedAt = Number(raw?.updatedAt) > 0 ? Number(raw.updatedAt) : now;
  const expiresAt = Number(raw?.expiresAt) > 0 ? Number(raw.expiresAt) : now + WECHAT_SYNC_TTL_MS;

  return {
    id: String(raw?.id || '').trim(),
    status: String(raw?.status || WECHAT_SYNC_STATUS.IDLE),
    sourceUrl: String(raw?.sourceUrl || '').trim(),
    sourceTabId: Number(raw?.sourceTabId || 0) || null,
    tabId: Number(raw?.tabId || 0) || null,
    templateId: String(raw?.templateId || '').trim(),
    createdAt,
    updatedAt,
    expiresAt,
    code: String(raw?.code || '').trim(),
    message: String(raw?.message || '').trim(),
    detail: raw?.detail && typeof raw.detail === 'object' ? raw.detail : null,
    lastRedirectToken: String(raw?.lastRedirectToken || '').trim()
  };
}

function isWechatSyncExpired(session) {
  const expiresAt = Number(session?.expiresAt || 0);
  return Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt;
}

function toWechatSyncPublicState(session) {
  const normalized = sanitizeWechatSyncSession(session);
  return {
    sessionId: normalized.id,
    status: normalized.status,
    code: normalized.code || '',
    message: normalized.message || '',
    detail: normalized.detail || null,
    tabId: normalized.tabId || null,
    updatedAt: normalized.updatedAt
  };
}

async function ensureWechatTemplateRegistry() {
  const store = await chrome.storage.local.get(WECHAT_TEMPLATE_REGISTRY_KEY);
  const current = store?.[WECHAT_TEMPLATE_REGISTRY_KEY];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current;
  }

  const initial = {
    version: 1,
    templates: {}
  };
  try {
    await chrome.storage.local.set({ [WECHAT_TEMPLATE_REGISTRY_KEY]: initial });
  } catch {
    // 若本地存储配额不足，则退化为内存默认值，不阻断主流程
  }
  return initial;
}

async function setWechatSyncSession(nextSession) {
  wechatSyncSessionLoaded = true;
  if (!nextSession) {
    wechatSyncSessionCache = null;
    await chrome.storage.local.remove(WECHAT_SYNC_SESSION_KEY).catch(() => undefined);
    return null;
  }

  const normalized = sanitizeWechatSyncSession(nextSession);
  wechatSyncSessionCache = normalized;
  try {
    await chrome.storage.local.set({ [WECHAT_SYNC_SESSION_KEY]: normalized });
  } catch {
    // 配额不足时仅保留内存态会话，保证当前同步流程不被中断
  }
  return normalized;
}

async function getWechatSyncSession() {
  if (!wechatSyncSessionLoaded) {
    const store = await chrome.storage.local.get(WECHAT_SYNC_SESSION_KEY);
    wechatSyncSessionCache = store?.[WECHAT_SYNC_SESSION_KEY] || null;
    wechatSyncSessionLoaded = true;
  }

  if (!wechatSyncSessionCache) {
    return null;
  }

  const normalized = sanitizeWechatSyncSession(wechatSyncSessionCache);
  if (isWechatSyncExpired(normalized) && !isWechatSyncTerminalStatus(normalized.status)) {
    clearWechatSyncPayload(normalized.id);
    const expired = {
      ...normalized,
      status: WECHAT_SYNC_STATUS.FAILED,
      code: 'WX_UNKNOWN',
      message: '公众号同步超时，请重试',
      updatedAt: Date.now()
    };
    return await setWechatSyncSession(expired);
  }

  wechatSyncSessionCache = normalized;
  return normalized;
}

async function startWechatSyncFlow(payload = {}, sender) {
  const normalizedPayload = normalizeWechatSyncPayload(payload);
  let resolvedTitle = normalizedPayload.title;
  let resolvedContentHtml = normalizedPayload.contentHtml;
  let resolvedTemplateId = normalizedPayload.templateId;
  const fallbackSourceTabId = normalizedPayload.sourceTabId || Number(sender?.tab?.id || 0) || null;

  if (!resolvedContentHtml && normalizedPayload.contentTransferId) {
    let transferred = null;
    try {
      transferred = contentTransferService.consumeTransferredContent(normalizedPayload.contentTransferId);
    } catch {
      throw new Error('公众号同步内容传输失败，请重新提取后重试');
    }

    const extractedPayload = extractWechatSyncTransferPayload(transferred);
    resolvedTitle = resolvedTitle || extractedPayload.title;
    resolvedContentHtml = resolvedContentHtml || extractedPayload.contentHtml;
    resolvedTemplateId = resolvedTemplateId || extractedPayload.templateId;
  }

  if (!resolvedContentHtml) {
    const recoveredFromCache = await resolveWechatSyncContentFromExtractCache({
      sourceTabId: fallbackSourceTabId,
      sourceUrl: normalizedPayload.sourceUrl,
      templateId: resolvedTemplateId
    });
    if (recoveredFromCache?.contentHtml) {
      resolvedTitle = resolvedTitle || recoveredFromCache.title;
      resolvedContentHtml = recoveredFromCache.contentHtml;
      resolvedTemplateId = resolvedTemplateId || recoveredFromCache.templateId;
      await appendLog('warn', 'wechat_sync', '公众号同步 payload 丢失，已自动从提取缓存恢复正文', {
        sourceTabId: fallbackSourceTabId,
        sourceUrl: normalizedPayload.sourceUrl
      });
    }
  }

  if (!resolvedContentHtml) {
    throw new Error('公众号同步内容为空，请先点击“重新提取”后重试');
  }

  await ensureWechatTemplateRegistry();

  const existing = await getWechatSyncSession();
  if (existing && !isWechatSyncTerminalStatus(existing.status)) {
    clearWechatSyncPayload(existing.id);
    await setWechatSyncSession({
      ...existing,
      status: WECHAT_SYNC_STATUS.CANCELLED,
      code: '',
      message: '新的公众号同步任务已启动，旧任务已取消',
      updatedAt: Date.now()
    });
  }

  const senderTabId = Number(sender?.tab?.id || 0) || null;
  const sourceTabId = normalizedPayload.sourceTabId || senderTabId;
  const sourceTab = sourceTabId ? await chrome.tabs.get(sourceTabId).catch(() => null) : null;

  const wechatTabs = await chrome.tabs.query({ url: ['https://mp.weixin.qq.com/*'] });
  const existingEditorTab = wechatTabs.find((tab) => isWechatEditorUrl(tab?.url || ''));
  const existingLoggedTab = wechatTabs.find((tab) => Boolean(getWechatMpToken(tab?.url || '')));
  let targetTab = null;

  if (existingEditorTab?.id) {
    targetTab = await chrome.tabs.update(existingEditorTab.id, { active: true }).catch(() => existingEditorTab);
  } else if (existingLoggedTab?.id) {
    const token = getWechatMpToken(existingLoggedTab.url || '');
    targetTab = await chrome.tabs
      .update(existingLoggedTab.id, { url: buildWechatEditorUrl(token), active: true })
      .catch(() => existingLoggedTab);
  } else {
    targetTab = await chrome.tabs.create({
      url: WECHAT_MP_HOME_URL,
      active: true,
      ...(Number.isInteger(sourceTab?.windowId) ? { windowId: sourceTab.windowId } : {})
    });
  }

  const now = Date.now();
  const sessionId = generateWechatSessionId();
  setWechatSyncPayload(sessionId, {
    title: resolvedTitle,
    contentHtml: resolvedContentHtml,
    templateId: resolvedTemplateId,
    expiresAt: now + WECHAT_SYNC_TTL_MS
  });

  const session = await setWechatSyncSession({
    id: sessionId,
    status: WECHAT_SYNC_STATUS.WAITING_LOGIN,
    sourceUrl: normalizedPayload.sourceUrl,
    sourceTabId: sourceTabId || null,
    tabId: Number(targetTab?.id || 0) || null,
    templateId: resolvedTemplateId,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + WECHAT_SYNC_TTL_MS,
    code: '',
    message: '请在公众号后台完成登录',
    detail: null
  });

  await appendLog('info', 'wechat_sync', '公众号同步任务已启动', {
    sessionId: session.id,
    tabId: session.tabId
  });

  if (session.tabId) {
    const latestTab = await chrome.tabs.get(session.tabId).catch(() => null);
    const latestUrl = String(latestTab?.url || targetTab?.url || '');
    if (latestUrl) {
      await handleWechatSyncSessionTabState(session, latestUrl, {
        tabId: session.tabId,
        changeStatus: latestTab?.status || ''
      });
    }
  }

  const latestSession = await getWechatSyncSession();
  return {
    sessionId: latestSession?.id || session.id,
    status: latestSession?.status || session.status,
    openedTabId: session.tabId
  };
}

async function checkWechatSyncStatus(payload = {}) {
  const requestedSessionId = String(payload?.sessionId || '').trim();
  const session = await getWechatSyncSession();
  if (!session) {
    return {
      sessionId: requestedSessionId,
      status: WECHAT_SYNC_STATUS.IDLE,
      code: '',
      message: '',
      detail: null,
      tabId: null,
      updatedAt: Date.now()
    };
  }

  if (requestedSessionId && requestedSessionId !== session.id) {
    return {
      sessionId: requestedSessionId,
      status: WECHAT_SYNC_STATUS.IDLE,
      code: '',
      message: '',
      detail: null,
      tabId: null,
      updatedAt: Date.now()
    };
  }

  return toWechatSyncPublicState(session);
}

async function cancelWechatSyncFlow(payload = {}) {
  const requestedSessionId = String(payload?.sessionId || '').trim();
  const session = await getWechatSyncSession();
  if (!session) {
    return {
      cancelled: false,
      sessionId: requestedSessionId,
      status: WECHAT_SYNC_STATUS.IDLE
    };
  }

  if (requestedSessionId && session.id && requestedSessionId !== session.id) {
    return {
      cancelled: false,
      sessionId: session.id,
      status: session.status
    };
  }

  if (isWechatSyncTerminalStatus(session.status)) {
    return {
      cancelled: true,
      sessionId: session.id,
      status: session.status
    };
  }

  const cancelledSession = await setWechatSyncSession({
    ...session,
    status: WECHAT_SYNC_STATUS.CANCELLED,
    code: '',
    message: '已取消公众号同步',
    updatedAt: Date.now()
  });
  clearWechatSyncPayload(cancelledSession.id);

  await appendLog('info', 'wechat_sync', '公众号同步任务已取消', {
    sessionId: cancelledSession.id
  });

  return {
    cancelled: true,
    sessionId: cancelledSession.id,
    status: cancelledSession.status
  };
}

async function handleWechatSyncTabUpdated(tabId, changeInfo, tab) {
  const session = await getWechatSyncSession();
  if (!session || isWechatSyncTerminalStatus(session.status)) {
    return;
  }

  if (session.tabId && Number(session.tabId) !== Number(tabId)) {
    return;
  }

  const currentUrl = String(changeInfo?.url || tab?.url || '').trim();
  if (!currentUrl) {
    return;
  }

  await handleWechatSyncSessionTabState(session, currentUrl, {
    tabId,
    changeStatus: String(changeInfo?.status || tab?.status || '')
  });
}

async function handleWechatSyncTabRemoved(tabId) {
  const session = await getWechatSyncSession();
  if (!session || isWechatSyncTerminalStatus(session.status)) {
    return;
  }

  if (Number(session.tabId || 0) !== Number(tabId || 0)) {
    return;
  }

  clearWechatSyncPayload(session.id);
  await setWechatSyncSession({
    ...session,
    status: WECHAT_SYNC_STATUS.FAILED,
    code: 'WX_UNKNOWN',
    message: '公众号同步标签页已关闭，请重试',
    updatedAt: Date.now()
  });
}

async function handleWechatSyncSessionTabState(session, currentUrl, context = {}) {
  if (!session || isWechatSyncTerminalStatus(session.status)) {
    return;
  }

  const tabId = Number(context?.tabId || session?.tabId || 0) || null;
  const changeStatus = String(context?.changeStatus || '').trim().toLowerCase();

  if (!isWechatMpUrl(currentUrl)) {
    if (changeStatus !== 'complete') {
      return;
    }
    const failedSession = await setWechatSyncSession({
      ...session,
      status: WECHAT_SYNC_STATUS.FAILED,
      code: 'WX_EDITOR_NOT_FOUND',
      message: '当前不是公众号后台页面，请重试',
      tabId
    });
    clearWechatSyncPayload(failedSession?.id || session.id);
    return;
  }

  const token = getWechatMpToken(currentUrl);
  if (!token) {
    if (session.status !== WECHAT_SYNC_STATUS.WAITING_LOGIN) {
      await setWechatSyncSession({
        ...session,
        status: WECHAT_SYNC_STATUS.WAITING_LOGIN,
        code: '',
        message: '请先在公众号后台完成登录',
        tabId
      });
    }
    return;
  }

  if (isWechatEditorUrl(currentUrl)) {
    if (changeStatus !== 'complete') {
      if (session.status !== WECHAT_SYNC_STATUS.WAITING_EDITOR) {
        await setWechatSyncSession({
          ...session,
          status: WECHAT_SYNC_STATUS.WAITING_EDITOR,
          code: '',
          message: '已识别登录态，等待编辑页加载完成',
          tabId
        });
      }
      return;
    }

    await runWechatEditorAutofill(session.id, tabId, currentUrl);
    return;
  }

  const nextSession = await setWechatSyncSession({
    ...session,
    status: WECHAT_SYNC_STATUS.WAITING_EDITOR,
    code: '',
    message: '已识别登录态，正在进入编辑页',
    tabId
  });

  if (nextSession.lastRedirectToken !== token && tabId) {
    await setWechatSyncSession({
      ...nextSession,
      lastRedirectToken: token,
      status: WECHAT_SYNC_STATUS.WAITING_EDITOR,
      code: '',
      message: '已识别登录态，正在进入编辑页',
      tabId
    });

    await chrome.tabs.update(tabId, { url: buildWechatEditorUrl(token) }).catch(async () => {
      const failedSession = await setWechatSyncSession({
        ...nextSession,
        status: WECHAT_SYNC_STATUS.FAILED,
        code: 'WX_EDITOR_NOT_FOUND',
        message: '无法自动打开公众号编辑页，请手动进入后重试',
        tabId
      });
      clearWechatSyncPayload(failedSession?.id || nextSession.id);
    });
  }
}

async function runWechatEditorAutofill(sessionId, tabId, currentUrl) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId || wechatSyncFillLocks.has(normalizedSessionId)) {
    return;
  }

  wechatSyncFillLocks.add(normalizedSessionId);

  try {
    const session = await getWechatSyncSession();
    if (!session || session.id !== normalizedSessionId || isWechatSyncTerminalStatus(session.status)) {
      return;
    }

    const payload = getWechatSyncPayload(normalizedSessionId);
    if (!payload?.contentHtml) {
      const failedSession = await setWechatSyncSession({
        ...session,
        status: WECHAT_SYNC_STATUS.FAILED,
        code: 'WX_UNKNOWN',
        message: '同步内容已失效，请回到同步页重新发起',
        tabId: Number(tabId || session.tabId || 0) || null
      });
      clearWechatSyncPayload(failedSession?.id || normalizedSessionId);
      return;
    }

    await setWechatSyncSession({
      ...session,
      status: WECHAT_SYNC_STATUS.FILLING,
      code: '',
      message: '正在自动填充标题和正文',
      tabId: Number(tabId || session.tabId || 0) || null
    });

    const contentHtml = String(payload.contentHtml || '').trim();
    const imageTextRunSignature = buildImageTextRunSignature(contentHtml, { maxTokens: 320 });
    const expectedInsertSteps = Math.max(1, Math.ceil(contentHtml.length / 12_000));

    const executionResult = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: autoFillWechatEditorInPage,
      args: [
        {
          title: payload.title,
          contentHtml,
          imageTextRunSignature,
          expectedInsertSteps,
          minContentLength: WECHAT_FILL_MIN_CONTENT_LENGTH
        }
      ]
    });

    const executionPayload = executionResult?.[0]?.result;
    const latestSession = await getWechatSyncSession();
    if (!latestSession || latestSession.id !== normalizedSessionId) {
      return;
    }

    if (!executionPayload?.ok) {
      const code = normalizeWechatSyncErrorCode(executionPayload?.code);
      const errorMessage = String(executionPayload?.error || '公众号自动填充失败');
      const failedSession = await setWechatSyncSession({
        ...latestSession,
        status: WECHAT_SYNC_STATUS.FAILED,
        code,
        message: errorMessage,
        detail:
          executionPayload?.detail && typeof executionPayload.detail === 'object'
            ? executionPayload.detail
            : null,
        tabId: Number(tabId || latestSession.tabId || 0) || null
      });
      clearWechatSyncPayload(failedSession?.id || normalizedSessionId);

      await appendLog('warn', 'wechat_sync', '公众号自动填充失败', {
        sessionId: normalizedSessionId,
        tabId,
        code,
        message: errorMessage
      });
      return;
    }

    const doneSession = await setWechatSyncSession({
      ...latestSession,
      status: WECHAT_SYNC_STATUS.DONE,
      code: '',
      message: '公众号标题与正文已自动填充完成',
      detail:
        executionPayload?.detail && typeof executionPayload.detail === 'object'
          ? executionPayload.detail
          : null,
      tabId: Number(tabId || latestSession.tabId || 0) || null
    });
    clearWechatSyncPayload(doneSession?.id || normalizedSessionId);

    await appendLog('info', 'wechat_sync', '公众号自动填充完成', {
      sessionId: normalizedSessionId,
      tabId,
      currentUrl,
      applyMethod: executionPayload?.detail?.applyMethod || '',
      performance: executionPayload?.detail?.performance || null
    });
  } catch (error) {
    const latestSession = await getWechatSyncSession();
    if (latestSession && latestSession.id === normalizedSessionId && !isWechatSyncTerminalStatus(latestSession.status)) {
      const failedSession = await setWechatSyncSession({
        ...latestSession,
        status: WECHAT_SYNC_STATUS.FAILED,
        code: 'WX_UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
        tabId: Number(tabId || latestSession.tabId || 0) || null
      });
      clearWechatSyncPayload(failedSession?.id || normalizedSessionId);
    }
  } finally {
    wechatSyncFillLocks.delete(normalizedSessionId);
  }
}

async function runPrepublishChecks(payload = {}) {
  const url = String(payload?.url || '').trim();
  const content = payload?.content || {};
  const settings = normalizeSourceSettingsPayload({
    ...(await getSourceSettings()),
    ...(payload?.sourceSettings || {})
  });
  const loginStatus = await checkFoodtalksLoginStatus();

  const usesDefaultCredential =
    settings.feishuAppId === DEFAULT_FEISHU_APP_ID && settings.feishuAppSecret === DEFAULT_FEISHU_APP_SECRET;
  const hasCredentials = Boolean(settings.feishuAppId && settings.feishuAppSecret);
  const hasValidSourceUrl = isFeishuDocUrl(url);
  const hasExtractedContent = Boolean(String(content?.contentHtml || '').trim());
  const extractedValidationOk = Boolean(content?.validation?.ok ?? hasExtractedContent);

  const checks = [
    {
      key: 'feishu_credentials',
      label: '飞书凭据',
      status: hasCredentials ? 'pass' : 'fail',
      code: hasCredentials ? (usesDefaultCredential ? 'FEISHU_CREDENTIAL_DEFAULT' : 'FEISHU_CREDENTIAL_READY') : 'FEISHU_CREDENTIAL_MISSING',
      message: hasCredentials
        ? usesDefaultCredential
          ? '使用默认凭据（建议替换为团队凭据）'
          : '凭据可用'
        : '缺少飞书凭据',
      action: hasCredentials ? null : { type: 'open_credentials', label: '填写凭据' }
    },
    {
      key: 'source_url',
      label: '来源链接',
      status: hasValidSourceUrl ? 'pass' : 'fail',
      code: hasValidSourceUrl ? 'SOURCE_URL_READY' : 'SOURCE_URL_INVALID',
      message: hasValidSourceUrl ? '链接合法' : '仅支持飞书 docx/wiki 链接',
      action: hasValidSourceUrl ? null : { type: 'focus_url', label: '修正链接' }
    },
    {
      key: 'content_integrity',
      label: '提取内容',
      status: hasExtractedContent ? (extractedValidationOk ? 'pass' : 'warn') : 'fail',
      code: hasExtractedContent ? (extractedValidationOk ? 'CONTENT_READY' : 'CONTENT_INCOMPLETE') : 'CONTENT_MISSING',
      message: hasExtractedContent ? (extractedValidationOk ? '内容完整性通过' : '内容存在缺失项，请检查后再发布') : '尚未提取内容',
      action: hasExtractedContent ? null : { type: 'reextract', label: '立即提取' }
    },
    {
      key: 'foodtalks_login',
      label: 'FoodTalks 登录',
      status: loginStatus.loggedIn ? 'pass' : 'warn',
      code: loginStatus.loggedIn ? 'FT_LOGIN_READY' : 'FT_LOGIN_REQUIRED',
      message: loginStatus.loggedIn ? '已检测到登录态' : '未检测到登录态',
      action: loginStatus.loggedIn ? null : { type: 'open_login', label: '去登录' }
    }
  ];

  return {
    checks,
    canProceed: checks.every((item) => item.status !== 'fail'),
    loginStatus
  };
}

async function handleFoodtalksLoginFlowTabUpdated(tabId, changeInfo, tab) {
  const flow = foodtalksLoginFlowByTabId.get(tabId);
  if (!flow) {
    return;
  }

  const currentUrl = String(changeInfo?.url || tab?.url || '').trim();
  if (!currentUrl) {
    return;
  }

  if (isFoodtalksLoginUrl(currentUrl)) {
    return;
  }

  if (isFoodtalksPublishUrl(currentUrl)) {
    if (changeInfo?.status !== 'complete') {
      return;
    }

    foodtalksLoginFlowByTabId.delete(tabId);
    return;
  }

  if (shouldRedirectToFoodtalksPublish(currentUrl)) {
    await chrome.tabs.update(tabId, { url: FOODTALKS_PUBLISH_URL });
  }
}

async function resolveWechatSyncContentFromExtractCache({ sourceTabId = null, sourceUrl = '', templateId = '' } = {}) {
  const cacheKeys = [];
  const tabCacheKey = getPopupExtractCacheKey(sourceTabId);
  const urlCacheKey = getPopupExtractUrlCacheKey(sourceUrl);
  if (tabCacheKey) {
    cacheKeys.push(tabCacheKey);
  }
  if (urlCacheKey && urlCacheKey !== tabCacheKey) {
    cacheKeys.push(urlCacheKey);
  }

  if (!cacheKeys.length) {
    return null;
  }

  let store = null;
  try {
    store = await chrome.storage.local.get(cacheKeys);
  } catch {
    return null;
  }

  for (const cacheKey of cacheKeys) {
    const cached = store?.[cacheKey];
    if (!cached || typeof cached !== 'object') {
      continue;
    }

    const cachedTitle = String(cached?.title || '').trim();
    const resolvedTemplateId = String(cached?.templateId || templateId || '').trim();
    const cachedWechatHtml = String(cached?.wechatHtml || '').trim();
    if (cachedWechatHtml) {
      return {
        title: cachedTitle,
        contentHtml: cachedWechatHtml,
        templateId: resolvedTemplateId
      };
    }

    const cachedSourceHtml = String(cached?.sourceHtml || cached?.html || '').trim();
    if (!cachedSourceHtml) {
      continue;
    }

    const rebuiltWechatHtml = buildWechatPasteHtml(cachedSourceHtml, {
      templateId: resolvedTemplateId
    });
    if (!rebuiltWechatHtml) {
      continue;
    }

    return {
      title: cachedTitle,
      contentHtml: rebuiltWechatHtml,
      templateId: resolvedTemplateId
    };
  }

  return null;
}

async function extractArticle({
  url,
  manualSelector = '',
  forceRefresh = false,
  sourceSettings = null,
  followTabs = true,
  sourceTabId = null
}) {
  if (!url || typeof url !== 'string') {
    throw new Error('请输入飞书文档链接');
  }

  const normalizedUrl = url.trim();
  if (!isSupportedSourceUrl(normalizedUrl)) {
    throw new Error('链接格式无效，仅支持飞书文档（*.feishu.cn/docx|wiki、*.larkoffice.com/docx|wiki）');
  }

  if (!forceRefresh) {
    const cached = await getCachedExtraction(normalizedUrl);
    if (cached) {
      await appendLog('info', 'extract', '命中缓存，跳过重复提取', { url: normalizedUrl });
      return { ...cached, cached: true };
    }
  }

  let lastError;

  for (let attempt = 1; attempt <= EXTRACTION_RETRY_LIMIT; attempt += 1) {
    try {
      await appendLog('info', 'extract', `开始提取内容（第 ${attempt} 次）`, {
        url: normalizedUrl,
        manualSelector
      });

      const rawData = await withTimeout(
        extractFeishuWithFallback({
          url: normalizedUrl,
          manualSelector,
          sourceSettings,
          followTabs,
          sourceTabId
        }),
        EXTRACTION_TIMEOUT_MS,
        '内容提取超时，请检查网络后重试'
      );

      const validation = evaluateExtractionIntegrity(rawData);
      const data = {
        ...rawData,
        sourceUrl: normalizedUrl,
        validation,
        extractedAt: new Date().toISOString()
      };

      await setCachedExtraction(normalizedUrl, data);
      await appendLog('info', 'extract', '提取完成', {
        url: normalizedUrl,
        words: data.wordCount,
        images: data.imageCount,
        warnings: validation.warnings.length
      });

      return { ...data, cached: false };
    } catch (error) {
      lastError = error;
      await appendLog('warn', 'extract', `提取失败（第 ${attempt} 次）`, {
        url: normalizedUrl,
        error: error instanceof Error ? error.message : String(error)
      });

      if (attempt < EXTRACTION_RETRY_LIMIT) {
        await delay(1200 * attempt);
      }
    }
  }

  throw lastError ?? new Error('提取失败，请稍后重试');
}

async function extractFeishuWithFallback({ url, manualSelector, sourceSettings, followTabs, sourceTabId }) {
  const credentials = await resolveFeishuCredentials(sourceSettings);

  if (credentials) {
    try {
      await appendLog('info', 'extract', '飞书提取：尝试 OpenAPI', { url });
      return await extractFeishuDocByApi({
        url,
        appId: credentials.appId,
        appSecret: credentials.appSecret
      });
    } catch (error) {
      if (isFeishuPermissionDeniedError(error)) {
        throw new Error('读取失败：请先在该飞书文档中添加应用（机器人）并授予文档访问权限，然后重试提取');
      }

      await appendLog('warn', 'extract', '飞书 OpenAPI 提取失败，切换页面兜底', {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  } else {
    await appendLog('warn', 'extract', '未配置飞书 App 凭据，使用页面兜底提取', { url });
  }

  const fallback = await extractByTabInjection(url, manualSelector, { followTabs, sourceTabId });

  if (credentials) {
    const hints = Array.isArray(fallback.validationHints) ? fallback.validationHints : [];
    hints.push('已回退到页面提取模式，建议检查飞书应用权限配置');
    fallback.validationHints = hints;
  }

  return fallback;
}

function isFeishuPermissionDeniedError(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  if (!message) {
    return false;
  }

  return /(forbidden|no permission|permission denied|权限|无权限|未授权|access denied|not authorized)/i.test(message) ||
    /(code=177003|code=91403|code=99991663|code=99991661)/i.test(message);
}

async function extractByTabInjection(url, manualSelector, { followTabs, sourceTabId }) {
  const normalizedTargetUrl = normalizeUrlForComparison(url);
  let tabId = null;
  let createdTabId = null;

  if (sourceTabId) {
    const sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
    const sourceUrl = normalizeUrlForComparison(sourceTab?.url || '');
    const shouldReuseSourceTab = Boolean(sourceTab?.id) && sourceUrl && sourceUrl === normalizedTargetUrl;
    if (shouldReuseSourceTab) {
      tabId = sourceTab.id;
    }
  }

  if (!tabId) {
    const tab = await chrome.tabs.create({ url, active: Boolean(followTabs) });
    tabId = tab.id || null;
    createdTabId = tab.id || null;
  }

  if (!tabId) {
    throw new Error('无法创建用于提取的标签页');
  }

  try {
    if (followTabs) {
      await activateTab(tabId);
    }

    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    await delay(isFeishuDocUrl(url) ? 2200 : 1200);

    const extractorFunc = isFeishuDocUrl(url) ? extractFeishuDocInPage : extractWechatArticleInPage;

    const executionResult = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractorFunc,
      args: [manualSelector]
    });

    const payload = executionResult?.[0]?.result;
    if (!payload?.ok) {
      throw new Error(payload?.error || '页面提取脚本执行失败');
    }

    return payload.data;
  } finally {
    if (createdTabId) {
      try {
        await chrome.tabs.remove(createdTabId);
      } catch {
        // 标签页可能被用户手动关闭
      }
    }

    if (createdTabId && followTabs && sourceTabId) {
      await activateTab(sourceTabId);
    }
  }
}

function normalizeUrlForComparison(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = new URL(text);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text.replace(/[?#].*$/, '');
  }
}

function evaluateExtractionIntegrity(article) {
  const missing = [];
  const warnings = [];

  if (!article?.title?.trim()) {
    missing.push('标题');
  }

  if (!article?.contentHtml?.trim()) {
    missing.push('正文');
  }

  if (!article?.wordCount) {
    warnings.push('正文字数为 0，可能存在提取异常');
  }

  if (!article?.coverUrl && !article?.coverToken) {
    warnings.push('未识别到封面图，可手动上传封面');
  }

  if (Array.isArray(article?.images)) {
    const invalidImages = article.images.filter((image) => !image?.src && !image?.token);
    if (invalidImages.length > 0) {
      warnings.push(`有 ${invalidImages.length} 张图片链接不完整，建议手动补提`);
    }
  }

  if ((article?.paragraphCount ?? 0) < 1) {
    warnings.push('未检测到段落结构，可能为特殊版式文章');
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
    summary: {
      wordCount: article?.wordCount ?? 0,
      imageCount: article?.imageCount ?? 0,
      paragraphCount: article?.paragraphCount ?? 0
    }
  };
}

async function publishContent({
  platformIds = [],
  content = {},
  contentTransferId = '',
  followTabs = true,
  sourceTabId = null
}) {
  if (!Array.isArray(platformIds) || platformIds.length === 0) {
    throw new Error('请至少选择一个发布平台');
  }

  const uniquePlatformIds = [...new Set(platformIds)].filter((id) => Boolean(PLATFORMS[id]));
  if (uniquePlatformIds.length === 0) {
    throw new Error('未识别到可用平台');
  }

  const rawContent = contentTransferId ? contentTransferService.consumeTransferredContent(contentTransferId) : content;
  const normalizedContent = normalizeContentPayload(rawContent);

  if (!normalizedContent.title) {
    throw new Error('发布前请填写文章标题');
  }

  if (!normalizedContent.contentHtml.trim() && !normalizedContent.textPlain.trim()) {
    throw new Error('发布前请确认正文内容不为空');
  }

  await appendLog('info', 'publish', '开始同步发布', {
    platformIds: uniquePlatformIds,
    title: normalizedContent.title
  });

  const results = [];
  const total = uniquePlatformIds.length;

  for (let index = 0; index < uniquePlatformIds.length; index += 1) {
    const platformId = uniquePlatformIds[index];
    const platform = PLATFORMS[platformId];

    try {
      broadcastProgress({
        phase: 'start',
        platformId,
        platformName: platform.name,
        current: index + 1,
        total,
        message: `开始处理 ${platform.name}`
      });

      const result = await publishWithRetry(platform, normalizedContent, index + 1, total, {
        followTabs,
        sourceTabId
      });
      const finalResult = {
        platformId,
        platformName: platform.name,
        status: 'success',
        tabId: result.tabId,
        attempts: result.attempts,
        warnings: result.warnings,
        detail: result.detail
      };

      results.push(finalResult);

      await appendLog('info', 'publish', `${platform.name} 自动填充完成`, {
        platformId,
        attempts: result.attempts,
        warnings: result.warnings
      });

      broadcastProgress({
        phase: 'success',
        platformId,
        platformName: platform.name,
        current: index + 1,
        total,
        message: `${platform.name} 已完成自动填充`,
        detail: result.detail
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallbackDraft = await saveFailedDraft(platformId, normalizedContent, message);
      const fallbackUrl = `${FALLBACK_PAGE_URL}?platform=${encodeURIComponent(platformId)}`;

      try {
        const fallbackTab = await chrome.tabs.create({ url: fallbackUrl, active: Boolean(followTabs) });
        if (followTabs && fallbackTab?.id) {
          await activateTab(fallbackTab.id);
        }
      } catch {
        // 回退页打开失败不影响主流程
      }

      const failResult = {
        platformId,
        platformName: platform.name,
        status: 'failed',
        error: message,
        fallbackDraftId: fallbackDraft.id,
        fallbackUrl
      };

      results.push(failResult);

      await appendLog('error', 'publish', `${platform.name} 发布失败，已生成回退草稿`, {
        platformId,
        error: message,
        fallbackDraftId: fallbackDraft.id
      });

      broadcastProgress({
        phase: 'failed',
        platformId,
        platformName: platform.name,
        current: index + 1,
        total,
        message: `${platform.name} 发布失败，已回退到草稿`,
        error: message
      });
    }
  }

  const summary = {
    total,
    success: results.filter((item) => item.status === 'success').length,
    failed: results.filter((item) => item.status === 'failed').length
  };

  await appendLog('info', 'publish', '同步发布流程结束', summary);

  broadcastProgress({
    phase: 'finish',
    current: total,
    total,
    message: `发布流程结束：成功 ${summary.success}，失败 ${summary.failed}`,
    summary
  });

  return { results, summary };
}

function normalizeContentPayload(content) {
  const title = typeof content?.title === 'string' ? content.title.trim() : '';
  const coverUrl = typeof content?.coverUrl === 'string' ? content.coverUrl.trim() : '';
  const contentHtml = typeof content?.contentHtml === 'string' ? content.contentHtml : '';
  const sourceUrl = typeof content?.sourceUrl === 'string' ? content.sourceUrl.trim() : '';
  const publishAction =
    content?.publishAction === 'publish'
      ? 'publish'
      : content?.publishAction === 'none'
      ? 'none'
      : 'draft';
  const preferImporter = content?.preferImporter !== false;

  let textPlain = typeof content?.textPlain === 'string' ? content.textPlain.trim() : '';
  if (!textPlain && contentHtml) {
    textPlain = stripHtml(contentHtml);
  }

  const images = Array.isArray(content?.images)
    ? content.images
        .map((item, index) => ({
          index,
          src: typeof item?.src === 'string' ? item.src : ''
        }))
        .filter((item) => item.src)
    : [];

  return {
    title,
    sourceUrl,
    coverUrl,
    contentHtml,
    textPlain,
    images,
    publishAction,
    preferImporter
  };
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function publishWithRetry(platform, content, current, total, options = {}) {
  let lastError;

  for (let attempt = 1; attempt <= PUBLISH_RETRY_LIMIT; attempt += 1) {
    try {
      broadcastProgress({
        phase: 'running',
        platformId: platform.id,
        platformName: platform.name,
        current,
        total,
        message: `${platform.name} 自动填充中（第 ${attempt} 次）`
      });

      const result = await publishOnPlatform(platform, content, options);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;

      if (attempt < PUBLISH_RETRY_LIMIT) {
        await appendLog('warn', 'publish', `${platform.name} 自动填充失败，准备重试`, {
          attempt,
          error: error instanceof Error ? error.message : String(error)
        });
        await delay(1200 * attempt);
      }
    }
  }

  throw lastError ?? new Error('发布失败');
}

async function publishOnPlatform(platform, content, options = {}) {
  const followTabs = Boolean(options.followTabs);
  const adapter = PLATFORM_ADAPTER_MAP[platform.id];
  const tab = await chrome.tabs.create({ url: platform.publishUrl, active: followTabs });
  const tabId = tab.id;

  if (!tabId) {
    throw new Error('发布页打开失败');
  }

  if (followTabs) {
    await activateTab(tabId);
  }

  await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
  await delay(1500);

  if (!adapter?.publishApi) {
    throw new Error(`平台适配器缺失：${platform.id}`);
  }

  const extractedPayload = adapter.extractor ? adapter.extractor(content) : { ...content };
  const processedPayload = adapter.contentProcessor
    ? adapter.contentProcessor(extractedPayload)
    : extractedPayload;
  const imageProcessedPayload = adapter.imageProcessor
    ? await adapter.imageProcessor(processedPayload)
    : processedPayload;

  const publishPayload = {
    ...imageProcessedPayload,
    platformId: platform.id,
    platformName: platform.name
  };

  const runtime = {
    withTimeout,
    executeInTab: ({ tabId: targetTabId, func, args = [], timeoutMs = 50_000 }) =>
      withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          world: 'ISOLATED',
          func,
          args
        }),
        timeoutMs,
        `${platform.name} 自动填充超时`
      )
  };

  const adapterResult = await adapter.publishApi({
    tabId,
    payload: publishPayload,
    runtime
  });

  if (!adapterResult?.ok && adapterResult?.code === 'LOGIN_REQUIRED' && platform.id === 'foodtalks') {
    await appendLog('info', 'publish', '检测到 FoodTalks 需要登录，等待用户登录完成', {
      platformId: platform.id,
      tabId
    });

    broadcastProgress({
      phase: 'running',
      platformId: platform.id,
      platformName: platform.name,
      current: 1,
      total: 1,
      message: '请在新标签页完成 FoodTalks 登录，登录后将自动继续填充...'
    });

    const loginCompleted = await waitForFoodtalksPostLogin(tabId, LOGIN_WAIT_TIMEOUT_MS);
    if (!loginCompleted) {
      throw new Error('FoodTalks 登录等待超时，请重新点击同步并在 3 分钟内完成登录');
    }

    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    await delay(1200);

    const retryResult = await adapter.publishApi({
      tabId,
      payload: publishPayload,
      runtime
    });

    if (!retryResult?.ok) {
      throw new Error(retryResult?.error || `${platform.name} 登录后自动填充失败`);
    }

    return {
      tabId,
      warnings: retryResult.warnings ?? [],
      detail: retryResult.detail ?? {}
    };
  }

  if (!adapterResult?.ok) {
    throw new Error(adapterResult?.error || `${platform.name} 自动填充失败`);
  }

  return {
    tabId,
    warnings: adapterResult.warnings ?? [],
    detail: adapterResult.detail ?? {}
  };
}

async function waitForFoodtalksPostLogin(tabId, timeoutMs = LOGIN_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(15_000, timeoutMs);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) {
      return false;
    }

    const url = String(tab.url || '');
    if (url.includes('admin-we.foodtalks.cn') && !url.includes('/#/login')) {
      return true;
    }

    await delay(900);
  }

  return false;
}

async function saveFailedDraft(platformId, content, errorMessage) {
  const drafts = await readFailedDrafts();

  const draft = {
    id: crypto.randomUUID(),
    platformId,
    title: content.title,
    coverUrl: content.coverUrl,
    contentHtml: content.contentHtml,
    textPlain: content.textPlain,
    images: content.images,
    errorMessage,
    createdAt: new Date().toISOString()
  };

  const merged = [draft, ...drafts].slice(0, MAX_FAILED_DRAFTS);
  await chrome.storage.local.set({ [FAILED_DRAFT_KEY]: merged });

  return draft;
}

async function readFailedDrafts() {
  const store = await chrome.storage.local.get(FAILED_DRAFT_KEY);
  const drafts = Array.isArray(store?.[FAILED_DRAFT_KEY]) ? store[FAILED_DRAFT_KEY] : [];

  return drafts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function broadcastProgress(payload) {
  try {
    chrome.runtime.sendMessage({ type: 'PUBLISH_PROGRESS', payload }).catch(() => undefined);
  } catch {
    // 无监听方时忽略
  }
}

async function activateTab(tabId) {
  if (!tabId) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // 标签页不存在或窗口无法聚焦时忽略
  }
}

async function reportPerfMetric(payload = {}) {
  const name = String(payload?.name || '').trim();
  const source = String(payload?.source || 'unknown').trim();
  const durationMs = Number(payload?.durationMs || 0);
  const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : {};
  if (!name) {
    return { recorded: false };
  }

  if (!Number.isFinite(durationMs) || durationMs < 100) {
    return { recorded: false };
  }

  await appendLog('info', 'perf', `${source}:${name} ${Math.round(durationMs)}ms`, {
    durationMs: Math.round(durationMs),
    source,
    ...detail
  });
  return { recorded: true };
}

async function appendLog(level, stage, message, detail = {}) {
  const entry = {
    id: crypto.randomUUID(),
    level,
    stage,
    message,
    detail,
    createdAt: new Date().toISOString()
  };

  try {
    const logs = await readLogs();
    const merged = [entry, ...logs].slice(0, MAX_LOG_ITEMS);
    await chrome.storage.local.set({ [LOG_KEY]: merged });
  } catch {
    // 日志持久化失败（如配额不足）时不影响主流程
  }

  try {
    chrome.runtime.sendMessage({ type: 'LOG_UPDATE', payload: entry }).catch(() => undefined);
  } catch {
    // no-op
  }

  return entry;
}

async function readLogs() {
  const store = await chrome.storage.local.get(LOG_KEY);
  const logs = Array.isArray(store?.[LOG_KEY]) ? store[LOG_KEY] : [];

  return logs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timeoutId;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) {
        return;
      }

      if (changeInfo.status === 'complete') {
        settled = true;
        cleanup();
        resolve();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error('标签页已关闭')); 
    };

    timeoutId = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new Error('页面加载超时')); 
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.get(tabId).then((tab) => {
      if (settled) {
        return;
      }

      if (tab?.status === 'complete') {
        settled = true;
        cleanup();
        resolve();
      }
    }).catch(() => undefined);
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

function isSupportedSourceUrl(url) {
  return isFeishuDocUrl(url);
}

function normalizeSourceSettingsPayload(payload = {}) {
  const feishuAppId = typeof payload?.feishuAppId === 'string' ? payload.feishuAppId.trim() : '';
  const feishuAppSecret =
    typeof payload?.feishuAppSecret === 'string' ? payload.feishuAppSecret.trim() : '';

  return {
    feishuAppId: feishuAppId || DEFAULT_FEISHU_APP_ID,
    feishuAppSecret: feishuAppSecret || DEFAULT_FEISHU_APP_SECRET
  };
}

async function getSourceSettings() {
  const store = await chrome.storage.local.get(SOURCE_SETTINGS_KEY);
  return normalizeSourceSettingsPayload(store?.[SOURCE_SETTINGS_KEY] || {});
}

async function saveSourceSettings(payload = {}) {
  const normalized = normalizeSourceSettingsPayload(payload);
  await chrome.storage.local.set({
    [SOURCE_SETTINGS_KEY]: normalized
  });
  await appendLog('info', 'extract', '飞书凭据已更新', {
    hasAppId: Boolean(normalized.feishuAppId),
    hasAppSecret: Boolean(normalized.feishuAppSecret)
  });
  return normalized;
}

async function resolveFeishuCredentials(overrideSettings = null) {
  const merged = normalizeSourceSettingsPayload({
    ...(await getSourceSettings()),
    ...(overrideSettings || {})
  });

  if (!merged.feishuAppId || !merged.feishuAppSecret) {
    return null;
  }

  return {
    appId: merged.feishuAppId,
    appSecret: merged.feishuAppSecret
  };
}

async function fetchFeishuImageDataUrl({ mediaToken, sourceSettings = null }) {
  const token = typeof mediaToken === 'string' ? mediaToken.trim() : '';
  if (!token) {
    throw new Error('缺少飞书图片 token');
  }

  const cached = feishuImageDataUrlCache.get(token);
  if (cached?.dataUrl) {
    return { dataUrl: cached.dataUrl, mimeType: cached.mimeType || '' };
  }

  const credentials = await resolveFeishuCredentials(sourceSettings);
  if (!credentials) {
    throw new Error('缺少飞书 App 凭据，请先在插件页面保存 App ID 与 App Secret');
  }

  let imageData = null;
  let lastError = null;
  const maxAttempts = FEISHU_IMAGE_FETCH_RETRY_LIMIT;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      imageData = await downloadFeishuImageAsDataUrl({
        mediaToken: token,
        appId: credentials.appId,
        appSecret: credentials.appSecret
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || isNonRetryableFeishuImageError(error)) {
        break;
      }
      await delay(FEISHU_IMAGE_FETCH_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  if (!imageData) {
    throw lastError instanceof Error ? lastError : new Error('飞书图片下载失败');
  }

  feishuImageDataUrlCache.set(token, imageData);

  if (feishuImageDataUrlCache.size > MAX_FEISHU_IMAGE_CACHE_ITEMS) {
    const oldestKey = feishuImageDataUrlCache.keys().next().value;
    if (oldestKey) {
      feishuImageDataUrlCache.delete(oldestKey);
    }
  }

  return imageData;
}

function isNonRetryableFeishuImageError(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  if (!message) {
    return false;
  }

  return /(缺少飞书 app 凭据|缺少飞书图片 token|permission|forbidden|unauthorized|无权限|未授权|401|403|177003|91403|99991663)/i.test(
    message
  );
}

async function cacheKey(url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getCachedExtraction(url) {
  const key = await cacheKey(url);
  const store = await chrome.storage.local.get(CACHE_KEY);
  const cache = store?.[CACHE_KEY] ?? {};
  const item = cache[key];

  if (!item) {
    return null;
  }

  if (Date.now() - item.cachedAt > CACHE_TTL_MS) {
    delete cache[key];
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
    return null;
  }

  return item.data;
}

async function setCachedExtraction(url, data) {
  const key = await cacheKey(url);
  const store = await chrome.storage.local.get(CACHE_KEY);
  const cache = store?.[CACHE_KEY] ?? {};

  cache[key] = {
    cachedAt: Date.now(),
    data
  };

  const sortedEntries = Object.entries(cache)
    .sort((a, b) => (b[1]?.cachedAt ?? 0) - (a[1]?.cachedAt ?? 0))
    .slice(0, MAX_CACHE_ITEMS);

  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(sortedEntries) });
}
