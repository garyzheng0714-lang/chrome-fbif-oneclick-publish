const dom = {
  urlInput: document.getElementById('urlInput'),
  feishuAppIdInput: document.getElementById('feishuAppIdInput'),
  feishuAppSecretInput: document.getElementById('feishuAppSecretInput'),
  settingsToggle: document.getElementById('settingsToggle'),
  settingsPanel: document.getElementById('settingsPanel'),
  actionButton: document.getElementById('actionButton'),
  hintText: document.getElementById('hintText'),
  hintLead: document.getElementById('hintLead'),
  hintBody: document.getElementById('hintBody')
};

const state = {
  sourceTabId: null,
  busy: false
};

bootstrap().catch((error) => {
  setHint('异常', error instanceof Error ? error.message : String(error), 'error');
});

async function bootstrap() {
  dom.settingsToggle?.addEventListener('click', toggleSettingsPanel);
  dom.urlInput?.addEventListener('input', onUrlInput);
  dom.actionButton?.addEventListener('click', onAction);

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

  if (isFeishuDocUrl(dom.urlInput.value.trim())) {
    setHint('已识别', '飞书文档，点击即可继续', 'success');
  } else {
    setHint('未识别', '请先打开飞书文档', 'error');
  }
}

function toggleSettingsPanel() {
  const isHidden = dom.settingsPanel.classList.contains('is-hidden');
  dom.settingsPanel.classList.toggle('is-hidden', !isHidden);
  dom.settingsToggle?.setAttribute('aria-expanded', String(isHidden));
}

function onUrlInput() {
  if (isFeishuDocUrl(dom.urlInput.value.trim())) {
    setHint('已识别', '飞书文档，点击即可继续', 'success');
  } else {
    setHint('未识别', '请先打开飞书文档', 'error');
  }
}

async function onAction() {
  if (state.busy) {
    return;
  }

  const url = String(dom.urlInput.value || '').trim();
  if (!url) {
    setHint('未识别', '请先打开飞书文档', 'error');
    return;
  }

  if (!isFeishuDocUrl(url)) {
    setHint('未识别', '当前链接不是飞书文档', 'error');
    return;
  }

  try {
    state.busy = true;
    dom.actionButton.disabled = true;
    dom.actionButton.textContent = '打开同步页...';

    await saveSourceSettings();

    const params = new URLSearchParams();
    params.set('sourceUrl', url);
    params.set('forceRefresh', '1');
    if (Number.isInteger(state.sourceTabId) && state.sourceTabId > 0) {
      params.set('sourceTabId', String(state.sourceTabId));
    }

    const panelUrl = `${chrome.runtime.getURL('panel.html')}?${params.toString()}`;
    await chrome.tabs.create({ url: panelUrl, active: true });

    window.close();
  } catch (error) {
    setHint('异常', error instanceof Error ? error.message : String(error), 'error');
    dom.actionButton.disabled = false;
    dom.actionButton.textContent = '提取并打开同步页';
    state.busy = false;
  }
}

function setHint(lead, body, tone) {
  dom.hintLead.textContent = String(lead || '');
  dom.hintBody.textContent = String(body || '');
  dom.hintText.dataset.tone = String(tone || 'info');
}

async function saveSourceSettings() {
  const response = await runtimeSend({
    type: 'SAVE_SOURCE_SETTINGS',
    payload: {
      feishuAppId: String(dom.feishuAppIdInput.value || '').trim(),
      feishuAppSecret: String(dom.feishuAppSecretInput.value || '').trim()
    }
  });

  if (!response.ok) {
    throw new Error(response.error || '保存飞书凭据失败');
  }
}

function isFeishuDocUrl(url) {
  return /^https?:\/\/([a-z0-9-]+\.)?(feishu\.cn|larkoffice\.com)\/(?:docx|wiki)\/[a-z0-9]+/i.test(String(url || '').trim());
}

async function getActiveTabInfo() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0] || null;
  return {
    id: Number(tab?.id || 0),
    url: String(tab?.url || '').trim()
  };
}

async function runtimeSend(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
