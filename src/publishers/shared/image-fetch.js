const IMAGE_URL_PATTERN = /<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*>/gi;

const DEFAULT_TIMEOUT_MS = 18_000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

function normalizeUrl(rawUrl = '') {
  const value = String(rawUrl || '').trim();
  if (!value) return '';

  const noHash = value.split('#')[0];
  if (noHash.startsWith('//')) {
    return `https:${noHash}`;
  }

  return noHash;
}

function extractImageUrlsFromHtml(html = '') {
  const source = String(html || '');
  const urls = [];
  let match = IMAGE_URL_PATTERN.exec(source);

  while (match) {
    const normalized = normalizeUrl(match[1]);
    if (normalized) urls.push(normalized);
    match = IMAGE_URL_PATTERN.exec(source);
  }

  return urls;
}

export function collectImageCandidates(payload = {}) {
  const fromList = Array.isArray(payload.images)
    ? payload.images
        .map((item) => normalizeUrl(item?.src || item?.url || ''))
        .filter(Boolean)
    : [];

  const fromHtml = extractImageUrlsFromHtml(payload.contentHtml || '');
  return [...new Set([...fromList, ...fromHtml])];
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function inferFileExtension(contentType = '') {
  const lower = contentType.toLowerCase();
  if (lower.includes('png')) return 'png';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('bmp')) return 'bmp';
  return 'jpg';
}

export async function fetchImageAsDataUrl(
  sourceUrl,
  { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, index = 0 } = {}
) {
  const url = normalizeUrl(sourceUrl);
  if (!url) {
    return { ok: false, error: 'empty-image-url', sourceUrl };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal
    });

    if (!response.ok) {
      return { ok: false, error: `image-http-${response.status}`, sourceUrl: url };
    }

    const blob = await response.blob();
    if (!blob || blob.size <= 0) {
      return { ok: false, error: 'image-empty-blob', sourceUrl: url };
    }

    if (blob.size > maxBytes) {
      return { ok: false, error: 'image-too-large', sourceUrl: url, size: blob.size };
    }

    const contentType = blob.type || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return { ok: false, error: 'image-invalid-content-type', sourceUrl: url, contentType };
    }

    const arrayBuffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    const ext = inferFileExtension(contentType);
    const dataUrl = `data:${contentType};base64,${base64}`;

    return {
      ok: true,
      sourceUrl: url,
      dataUrl,
      name: `xhs-${Date.now()}-${index}.${ext}`,
      type: contentType,
      size: blob.size
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      sourceUrl: url
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareImagesForUpload(
  payload,
  { maxCount = 9, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}
) {
  const candidates = collectImageCandidates(payload).slice(0, maxCount);
  const prepared = [];
  const failed = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const result = await fetchImageAsDataUrl(candidates[index], {
      timeoutMs,
      maxBytes,
      index
    });

    if (result.ok) prepared.push(result);
    else failed.push(result);
  }

  return {
    candidates,
    prepared,
    failed
  };
}
