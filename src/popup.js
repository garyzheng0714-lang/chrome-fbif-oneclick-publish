import { buildFoodtalksPasteHtml, validatePublishHtmlImages } from './shared/foodtalks-html.js';
import {
  clampProgress,
  getActionButtonConfig,
  POPUP_MODES,
  shouldShowReextractButton,
  SYNC_TARGETS
} from './shared/popup-flow.js';
import {
  getPopupExtractCacheKey,
  getPopupExtractUrlCacheKey,
  normalizeSourceUrlForCache
} from './shared/popup-extract-cache.js';

const WECHAT_HOME_URL = 'https://mp.weixin.qq.com/';

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
  hintBody: document.getElementById('hintBody')
};

const state = {
  mode: POPUP_MODES.EXTRACT,
  target: SYNC_TARGETS.FOODTALKS,
  pendingHtml: '',
  sourceTabId: null,
  cachedAt: null,
  loginOpened: false,
  progressValue: 0,
  progressTimer: null
};

bootstrap().catch((error) => {
  setHint(error instanceof Error ? error.message : String(error), 'error');
});

async function bootstrap() {
  dom.actionButton?.addEventListener('click', onAction);
  dom.reextractButton?.addEventListener('click', onReextract);
  dom.urlInput?.addEventListener('input', onUrlInputChange);
  dom.settingsToggle?.addEventListener('click', toggleSettingsPanel);
  dom.targetInputs.forEach((input) => input.addEventListener('change', onTargetChange));

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

  const preselectedTarget = dom.targetInputs.find((item) => item.checked)?.value;
  if (preselectedTarget === SYNC_TARGETS.WECHAT) {
    state.target = SYNC_TARGETS.WECHAT;
  }

  setMode(POPUP_MODES.EXTRACT);
  setProgress(0);
  const restored = await restoreExtractCacheIfAvailable();
  if (restored) {
    return;
  }

  if (isFeishuDocUrl(dom.urlInput.value.trim())) {
    setHintWithLead('已识别', '飞书文档，可点击提取', 'success');
  } else {
    setHintWithLead('未识别', '请先打开飞书文档', 'error');
  }
}

function onUrlInputChange() {
  if (state.mode !== POPUP_MODES.EXTRACT && state.mode !== POPUP_MODES.EXTRACTING) {
    state.pendingHtml = '';
    state.cachedAt = null;
    state.loginOpened = false;
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

  try {
    const sourceSettings = collectSourceSettings();
    await saveSourceSettings(sourceSettings);

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

    if (!extractResponse.ok) {
      throw new Error(formatExtractError(extractResponse.error || '提取失败'));
    }

    let contentHtml = String(extractResponse.data?.contentHtml || '').trim();
    if (!contentHtml) {
      throw new Error('提取结果为空');
    }

    const hydration = await hydrateFeishuHtmlAssets(contentHtml, sourceSettings);
    contentHtml = hydration.html;
    if (hydration.failedTokens.length > 0) {
      throw new Error(`有 ${hydration.failedTokens.length} 张图片拉取失败`);
    }

    const finalHtml = buildFoodtalksPasteHtml(contentHtml);
    if (!finalHtml) {
      throw new Error('代码生成为空');
    }

    const imageCheck = validatePublishHtmlImages(finalHtml);
    if (imageCheck.invalidCount > 0) {
      throw new Error(`有 ${imageCheck.invalidCount} 张图片未就绪`);
    }

    state.pendingHtml = finalHtml;
    state.cachedAt = Date.now();
    state.loginOpened = false;
    await persistExtractCache(url, finalHtml, state.cachedAt);
    dom.targetSection.classList.remove('is-hidden');
    finishProgress(true);
    setMode(POPUP_MODES.SYNC);
    setHint('请选择同步目标', 'success');
  } catch (error) {
    finishProgress(false);
    state.pendingHtml = '';
    state.cachedAt = null;
    dom.targetSection.classList.add('is-hidden');
    setMode(POPUP_MODES.EXTRACT);
    setHint(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function runSyncAction() {
  if (!state.pendingHtml) {
    setMode(POPUP_MODES.EXTRACT);
    dom.targetSection.classList.add('is-hidden');
    setHint('请先提取内容', 'error');
    return;
  }

  if (state.target === SYNC_TARGETS.WECHAT) {
    try {
      await chrome.tabs.create({ url: WECHAT_HOME_URL, active: true });
      setMode(POPUP_MODES.SYNC);
      setHint('已打开公众号后台', 'success');
    } catch {
      setHint('无法打开公众号后台', 'error');
    }
    return;
  }

  try {
    await copyTextToClipboard(state.pendingHtml);
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

  renderActionButton();
}

function renderActionButton() {
  const config = getActionButtonConfig(state.mode, state.target, state.progressValue);
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

async function persistExtractCache(sourceUrl, html, updatedAt = Date.now()) {
  const tabCacheKey = getPopupExtractCacheKey(state.sourceTabId);
  const urlCacheKey = getPopupExtractUrlCacheKey(sourceUrl);
  if (!tabCacheKey && !urlCacheKey) return;

  const cachedHtml = String(html || '').trim();
  if (!cachedHtml) {
    return;
  }

  try {
    const payload = {
      sourceUrl: String(sourceUrl || '').trim(),
      html: cachedHtml,
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
  const cachedHtml = String(cached?.html || '').trim();
  if (!cachedHtml) {
    return false;
  }

  const cachedSourceUrl = normalizeSourceUrlForCache(cached?.sourceUrl);
  if (currentUrl && cachedSourceUrl && currentUrl !== cachedSourceUrl) {
    return false;
  }

  state.pendingHtml = cachedHtml;
  state.cachedAt = Number(cached?.updatedAt) || null;
  state.loginOpened = false;
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
  for (const token of tokens) {
    const response = await runtimeSend({
      type: 'FETCH_FEISHU_IMAGE',
      payload: {
        mediaToken: token,
        sourceSettings
      }
    });

    if (!response.ok || !response.dataUrl) {
      failedTokens.push(token);
      continue;
    }

    const boundNodes = tokenNodeMap.get(token) || [];
    boundNodes.forEach((node) => {
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
  const normalized = String(text || '').trim();
  if (!normalized) {
    throw new Error('复制内容为空');
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
