export const POPUP_EXTRACT_CACHE_KEY_PREFIX = 'fbif_popup_extract_cache_v1_';
export const POPUP_EXTRACT_URL_CACHE_KEY_PREFIX = 'fbif_popup_extract_cache_url_v1_';

export function getPopupExtractCacheKey(tabId) {
  const normalizedTabId = Number(tabId);
  if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) {
    return '';
  }

  return `${POPUP_EXTRACT_CACHE_KEY_PREFIX}${normalizedTabId}`;
}

export function normalizeSourceUrlForCache(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw;
  }
}

export function getPopupExtractUrlCacheKey(url) {
  const normalizedUrl = normalizeSourceUrlForCache(url);
  if (!normalizedUrl) {
    return '';
  }

  return `${POPUP_EXTRACT_URL_CACHE_KEY_PREFIX}${encodeURIComponent(normalizedUrl)}`;
}
