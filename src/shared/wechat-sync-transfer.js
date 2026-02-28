export const DIRECT_WECHAT_SYNC_MESSAGE_LIMIT_BYTES = 256 * 1024;
export const CONTENT_CHUNK_CHAR_SIZE = 160_000;

function toSafeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export function getWechatSyncTransferPlan(serializedContent, options = {}) {
  const payload = String(serializedContent || '');
  const directLimitBytes = toSafeNumber(options.directLimitBytes, DIRECT_WECHAT_SYNC_MESSAGE_LIMIT_BYTES);
  const chunkCharSize = toSafeNumber(options.chunkCharSize, CONTENT_CHUNK_CHAR_SIZE);
  const contentBytes = new TextEncoder().encode(payload).length;

  if (contentBytes <= directLimitBytes) {
    return {
      mode: 'direct',
      contentBytes,
      totalChunks: 0
    };
  }

  return {
    mode: 'chunked',
    contentBytes,
    totalChunks: Math.max(1, Math.ceil(payload.length / chunkCharSize))
  };
}

export function splitSerializedContentForTransfer(serializedContent, options = {}) {
  const payload = String(serializedContent || '');
  if (!payload) {
    return [];
  }

  const chunkCharSize = toSafeNumber(options.chunkCharSize, CONTENT_CHUNK_CHAR_SIZE);
  const chunks = [];
  for (let index = 0; index < payload.length; index += chunkCharSize) {
    chunks.push(payload.slice(index, index + chunkCharSize));
  }

  return chunks;
}
