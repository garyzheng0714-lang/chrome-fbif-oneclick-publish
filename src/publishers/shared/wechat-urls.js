export const WECHAT_MP_HOST = 'mp.weixin.qq.com';
export const WECHAT_MP_HOME_URL = 'https://mp.weixin.qq.com/';

function parseUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) {
    return null;
  }

  try {
    return new URL(text);
  } catch {
    return null;
  }
}

export function isWechatMpUrl(rawUrl) {
  const parsed = parseUrl(rawUrl);
  return Boolean(parsed) && String(parsed.hostname || '').toLowerCase() === WECHAT_MP_HOST;
}

export function getWechatMpToken(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed || !isWechatMpUrl(rawUrl)) {
    return '';
  }
  return String(parsed.searchParams.get('token') || '').trim();
}

export function isWechatEditorUrl(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed || !isWechatMpUrl(rawUrl)) {
    return false;
  }

  const pathname = String(parsed.pathname || '').toLowerCase();
  const t = String(parsed.searchParams.get('t') || '').toLowerCase();

  if (pathname === '/cgi-bin/appmsg' || pathname === '/cgi-bin/operate_appmsg') {
    return true;
  }

  if (pathname.startsWith('/cgi-bin/appmsg') || pathname.startsWith('/cgi-bin/operate_appmsg')) {
    return true;
  }

  if (t.includes('media/appmsg_edit')) {
    return true;
  }

  return false;
}

export function buildWechatEditorUrl(token = '') {
  const params = new URLSearchParams();
  params.set('t', 'media/appmsg_edit_v2');
  params.set('isNew', '1');
  params.set('type', '10');
  params.set('action', 'edit');
  params.set('lang', 'zh_CN');

  const normalizedToken = String(token || '').trim();
  if (normalizedToken) {
    params.set('token', normalizedToken);
  }

  return `https://${WECHAT_MP_HOST}/cgi-bin/appmsg?${params.toString()}`;
}
