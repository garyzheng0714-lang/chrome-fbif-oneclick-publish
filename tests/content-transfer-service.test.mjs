import test from 'node:test';
import assert from 'node:assert/strict';

import { createContentTransferService } from '../src/background/content-transfer-service.js';

test('content transfer service: begin append consume', () => {
  const service = createContentTransferService({ ttlMs: 10_000, maxTransfers: 2 });
  service.beginContentTransfer({
    transferId: 't1',
    totalChunks: 2
  });

  service.appendContentChunk({ transferId: 't1', index: 0, chunk: '{"title":"A",' });
  service.appendContentChunk({ transferId: 't1', index: 1, chunk: '"contentHtml":"<p>x</p>"}' });

  assert.deepEqual(service.consumeTransferredContent('t1'), {
    title: 'A',
    contentHtml: '<p>x</p>'
  });
});

test('content transfer service: consume fails for incomplete chunks', () => {
  const service = createContentTransferService({ ttlMs: 10_000, maxTransfers: 2 });
  service.beginContentTransfer({
    transferId: 't2',
    totalChunks: 2
  });

  service.appendContentChunk({ transferId: 't2', index: 0, chunk: '{"title":"A"}' });

  assert.throws(() => service.consumeTransferredContent('t2'), /内容分片不完整/);
});

test('content transfer service: clear transfer', () => {
  const service = createContentTransferService({ ttlMs: 10_000, maxTransfers: 2 });
  service.beginContentTransfer({
    transferId: 't3',
    totalChunks: 1
  });
  service.clearContentTransfer('t3');
  assert.throws(() => service.consumeTransferredContent('t3'), /会话不存在或已过期/);
});

