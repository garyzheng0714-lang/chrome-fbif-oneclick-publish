import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_CHUNK_CHAR_SIZE,
  DIRECT_WECHAT_SYNC_MESSAGE_LIMIT_BYTES,
  getWechatSyncTransferPlan,
  splitSerializedContentForTransfer
} from '../src/shared/wechat-sync-transfer.js';

test('getWechatSyncTransferPlan uses direct mode for small payload', () => {
  const payload = JSON.stringify({ title: 'A', contentHtml: '<p>short</p>' });
  const plan = getWechatSyncTransferPlan(payload);
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.totalChunks, 0);
  assert.equal(plan.contentBytes <= DIRECT_WECHAT_SYNC_MESSAGE_LIMIT_BYTES, true);
});

test('getWechatSyncTransferPlan returns chunked plan for large payload', () => {
  const payload = 'x'.repeat(CONTENT_CHUNK_CHAR_SIZE * 2 + 23);
  const plan = getWechatSyncTransferPlan(payload, {
    directLimitBytes: 128,
    chunkCharSize: CONTENT_CHUNK_CHAR_SIZE
  });
  assert.equal(plan.mode, 'chunked');
  assert.equal(plan.totalChunks, 3);
  assert.equal(plan.contentBytes > 128, true);
});

test('splitSerializedContentForTransfer splits payload with fixed chunk size', () => {
  const payload = 'abcdefghij';
  const chunks = splitSerializedContentForTransfer(payload, { chunkCharSize: 4 });
  assert.deepEqual(chunks, ['abcd', 'efgh', 'ij']);
});

test('splitSerializedContentForTransfer returns empty array for empty payload', () => {
  const chunks = splitSerializedContentForTransfer('', { chunkCharSize: 10 });
  assert.deepEqual(chunks, []);
});
