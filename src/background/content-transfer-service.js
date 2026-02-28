export function createContentTransferService(options = {}) {
  const ttlMs = Math.max(60_000, Number(options?.ttlMs) || 0);
  const maxTransfers = Math.max(1, Number(options?.maxTransfers) || 1);
  const store = new Map();

  function cleanupExpiredTransfers() {
    const now = Date.now();
    for (const [transferId, transfer] of store.entries()) {
      if (!transfer || now - Number(transfer.createdAt || 0) > ttlMs) {
        store.delete(transferId);
      }
    }
  }

  function beginContentTransfer(payload = {}) {
    cleanupExpiredTransfers();

    const transferId = String(payload.transferId || '').trim();
    const totalChunks = Math.max(1, Number(payload.totalChunks) || 0);
    const contentSize = Math.max(0, Number(payload.contentSize) || 0);
    if (!transferId) {
      throw new Error('transferId 缺失');
    }
    if (!Number.isFinite(totalChunks) || totalChunks < 1) {
      throw new Error('内容分片数量无效');
    }

    if (!store.has(transferId) && store.size >= maxTransfers) {
      const firstKey = store.keys().next().value;
      if (firstKey) {
        store.delete(firstKey);
      }
    }

    store.set(transferId, {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalChunks,
      contentSize,
      chunks: new Array(totalChunks).fill(null),
      receivedCount: 0
    });

    return { transferId, totalChunks };
  }

  function appendContentChunk(payload = {}) {
    cleanupExpiredTransfers();

    const transferId = String(payload.transferId || '').trim();
    const chunkIndex = Number(payload.index);
    const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';

    const transfer = store.get(transferId);
    if (!transfer) {
      throw new Error('内容传输会话不存在或已过期');
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= transfer.totalChunks) {
      throw new Error('分片序号无效');
    }

    if (!chunk.length) {
      throw new Error('分片内容为空');
    }

    if (!transfer.chunks[chunkIndex]) {
      transfer.receivedCount += 1;
    }

    transfer.chunks[chunkIndex] = chunk;
    transfer.updatedAt = Date.now();
    store.set(transferId, transfer);

    return {
      transferId,
      index: chunkIndex,
      receivedCount: transfer.receivedCount,
      totalChunks: transfer.totalChunks
    };
  }

  function clearContentTransfer(transferId) {
    const normalizedId = String(transferId || '').trim();
    if (!normalizedId) {
      return;
    }
    store.delete(normalizedId);
  }

  function consumeTransferredContent(transferId) {
    cleanupExpiredTransfers();

    const normalizedId = String(transferId || '').trim();
    if (!normalizedId) {
      throw new Error('contentTransferId 缺失');
    }

    const transfer = store.get(normalizedId);
    if (!transfer) {
      throw new Error('大内容传输会话不存在或已过期，请重新同步');
    }

    if (transfer.receivedCount !== transfer.totalChunks || transfer.chunks.some((chunk) => typeof chunk !== 'string')) {
      throw new Error('内容分片不完整，请重试同步');
    }

    const serialized = transfer.chunks.join('');
    store.delete(normalizedId);

    try {
      return JSON.parse(serialized);
    } catch {
      throw new Error('内容分片解析失败，请重新同步');
    }
  }

  return {
    beginContentTransfer,
    appendContentChunk,
    clearContentTransfer,
    consumeTransferredContent,
    cleanupExpiredTransfers
  };
}

