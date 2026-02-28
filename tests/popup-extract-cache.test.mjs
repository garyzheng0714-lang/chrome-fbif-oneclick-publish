import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPopupExtractCacheKey,
  getPopupExtractUrlCacheKey,
  normalizeSourceUrlForCache
} from '../src/shared/popup-extract-cache.js';

test('getPopupExtractCacheKey returns namespaced key for valid tab id', () => {
  assert.equal(getPopupExtractCacheKey(12), 'fbif_popup_extract_cache_v1_12');
  assert.equal(getPopupExtractCacheKey('7'), 'fbif_popup_extract_cache_v1_7');
});

test('getPopupExtractCacheKey returns empty string for invalid tab id', () => {
  assert.equal(getPopupExtractCacheKey(0), '');
  assert.equal(getPopupExtractCacheKey(-1), '');
  assert.equal(getPopupExtractCacheKey('bad'), '');
});

test('normalizeSourceUrlForCache strips hash and preserves path', () => {
  assert.equal(
    normalizeSourceUrlForCache('https://foo.feishu.cn/docx/abc123?from=copy#block-id'),
    'https://foo.feishu.cn/docx/abc123'
  );
  assert.equal(normalizeSourceUrlForCache(''), '');
});

test('getPopupExtractUrlCacheKey builds deterministic key by normalized url', () => {
  const key = getPopupExtractUrlCacheKey('https://foo.feishu.cn/docx/abc123?from=copy#x');
  assert.equal(key, 'fbif_popup_extract_cache_url_v1_https%3A%2F%2Ffoo.feishu.cn%2Fdocx%2Fabc123');
  assert.equal(getPopupExtractUrlCacheKey(''), '');
});
