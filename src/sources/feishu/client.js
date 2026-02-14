const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const TOKEN_REFRESH_BUFFER_MS = 60_000;

const tenantTokenCache = new Map();

function normalizeText(value) {
  return String(value || '').trim();
}

function buildTenantCacheKey(appId, appSecret) {
  return `${appId}::${appSecret}`;
}

async function requestJson(fetchImpl, url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers,
    body
  });

  const raw = await response.text();
  let payload = null;

  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.msg || payload?.message || raw || `HTTP ${response.status}`;
    throw new Error(`飞书接口请求失败（${response.status}）：${detail}`);
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('飞书接口返回了非 JSON 内容');
  }

  if (payload.code !== 0) {
    throw new Error(`飞书接口错误（code=${payload.code}）：${payload.msg || 'unknown error'}`);
  }

  return payload.data || {};
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

async function requestTenantAccessToken(fetchImpl, appId, appSecret) {
  const now = Date.now();
  const cacheKey = buildTenantCacheKey(appId, appSecret);
  const cached = tenantTokenCache.get(cacheKey);

  if (cached && now < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return cached.token;
  }

  const response = await fetchImpl(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });

  const raw = await response.text();
  let payload = null;

  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.msg || payload?.message || raw || `HTTP ${response.status}`;
    throw new Error(`飞书 token 请求失败（${response.status}）：${detail}`);
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('飞书 token 接口返回了非 JSON 内容');
  }

  if (payload.code !== 0) {
    throw new Error(`飞书 token 接口错误（code=${payload.code}）：${payload.msg || 'unknown error'}`);
  }

  const token = normalizeText(payload.tenant_access_token || payload.data?.tenant_access_token);
  const expireSeconds = Number(payload.expire || payload.data?.expire || 0);
  if (!token || !expireSeconds) {
    throw new Error('飞书 tenant_access_token 获取失败，请检查 App 凭据');
  }

  tenantTokenCache.set(cacheKey, {
    token,
    expiresAt: now + expireSeconds * 1000
  });

  return token;
}

export function createFeishuClient({ appId, appSecret, fetchImpl = fetch }) {
  const safeAppId = normalizeText(appId);
  const safeAppSecret = normalizeText(appSecret);

  if (!safeAppId || !safeAppSecret) {
    throw new Error('缺少飞书 App ID 或 App Secret');
  }

  async function request(pathWithQuery, init = {}) {
    const token = await requestTenantAccessToken(fetchImpl, safeAppId, safeAppSecret);
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {})
    };

    return requestJson(fetchImpl, `${FEISHU_API_BASE}${pathWithQuery}`, {
      method: init.method || 'GET',
      headers,
      body: init.body
    });
  }

  async function requestBinary(pathWithQuery) {
    const token = await requestTenantAccessToken(fetchImpl, safeAppId, safeAppSecret);
    const response = await fetchImpl(`${FEISHU_API_BASE}${pathWithQuery}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(`飞书媒体下载失败（${response.status}）：${message || 'unknown error'}`);
    }

    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = await response.arrayBuffer();

    return {
      mimeType,
      dataUrl: `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`
    };
  }

  async function getDocument(docToken) {
    return request(`/docx/v1/documents/${encodeURIComponent(docToken)}`);
  }

  async function listDocumentBlocks(docToken, { pageSize = 500 } = {}) {
    const items = [];
    let pageToken = '';
    let guard = 0;

    do {
      const query = new URLSearchParams({ page_size: String(pageSize) });
      if (pageToken) {
        query.set('page_token', pageToken);
      }

      const data = await request(`/docx/v1/documents/${encodeURIComponent(docToken)}/blocks?${query.toString()}`);
      items.push(...(Array.isArray(data.items) ? data.items : []));
      pageToken = normalizeText(data.page_token);
      guard += 1;

      if (!data.has_more) {
        break;
      }

      if (guard > 30) {
        throw new Error('飞书 blocks 分页数量异常，已终止提取');
      }
    } while (pageToken);

    return items;
  }

  async function downloadMediaAsDataUrl(mediaToken) {
    return requestBinary(`/drive/v1/medias/${encodeURIComponent(mediaToken)}/download`);
  }

  return {
    getDocument,
    listDocumentBlocks,
    downloadMediaAsDataUrl
  };
}
