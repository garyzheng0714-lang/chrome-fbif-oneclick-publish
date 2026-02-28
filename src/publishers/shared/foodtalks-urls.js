export const FOODTALKS_LOGIN_URL = 'https://admin-we.foodtalks.cn/#/login';
export const FOODTALKS_PUBLISH_URL = 'https://admin-we.foodtalks.cn/#/radar/news/publish';

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

function normalizeHashPath(rawHash) {
  const hash = String(rawHash || '').trim();
  if (!hash.startsWith('#/')) {
    return '';
  }

  const withoutPrefix = hash.slice(1);
  const [pathOnly] = withoutPrefix.split('?');
  return String(pathOnly || '').toLowerCase();
}

export function isFoodtalksAdminUrl(rawUrl) {
  const parsed = parseUrl(rawUrl);
  return Boolean(parsed) && String(parsed.hostname || '').toLowerCase() === 'admin-we.foodtalks.cn';
}

export function isFoodtalksLoginUrl(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed || !isFoodtalksAdminUrl(rawUrl)) {
    return false;
  }

  const hashPath = normalizeHashPath(parsed.hash);
  return hashPath.startsWith('/login');
}

export function isFoodtalksPublishUrl(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed || !isFoodtalksAdminUrl(rawUrl)) {
    return false;
  }

  const hashPath = normalizeHashPath(parsed.hash);
  return hashPath.startsWith('/radar/news/publish');
}

export function shouldRedirectToFoodtalksPublish(rawUrl) {
  return isFoodtalksAdminUrl(rawUrl) && !isFoodtalksLoginUrl(rawUrl) && !isFoodtalksPublishUrl(rawUrl);
}
