import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_ADAPTERS } from '../src/publishers/index.js';
import { processFoodtalksContent } from '../src/publishers/foodtalks/content-processor.js';
import { extractFoodtalksContent } from '../src/publishers/foodtalks/extractor.js';
import { FOODTALKS_SELECTORS } from '../src/publishers/foodtalks/selectors.js';
import { collectImageCandidates } from '../src/publishers/shared/image-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const REQUIRED_FILES = ['extractor.js', 'content-processor.js', 'image-processor.js', 'publish-api.js'];

test('FoodTalks adapter exposes standardized interface', () => {
  assert.ok(Array.isArray(PLATFORM_ADAPTERS));
  assert.equal(PLATFORM_ADAPTERS.length, 1);

  const adapter = PLATFORM_ADAPTERS[0];
  assert.equal(adapter.id, 'foodtalks');
  assert.equal(adapter.name, 'FoodTalks');
  assert.equal(adapter.publishUrl, 'https://admin-we.foodtalks.cn/#/radar/news/publish');
  assert.equal(typeof adapter.extractor, 'function');
  assert.equal(typeof adapter.contentProcessor, 'function');
  assert.equal(typeof adapter.imageProcessor, 'function');
  assert.equal(typeof adapter.publishApi, 'function');
});

test('foodtalks folder includes extractor/processor/image/publish files', () => {
  const folder = path.join(rootDir, 'src', 'publishers', 'foodtalks');
  assert.equal(fs.existsSync(folder), true, 'foodtalks folder missing');

  for (const file of REQUIRED_FILES) {
    assert.equal(fs.existsSync(path.join(folder, file)), true, `foodtalks/${file} missing`);
  }
});

test('foodtalks content processor strips unsafe payloads', () => {
  const processed = processFoodtalksContent({
    contentHtml: '<p>Hello</p><script>alert(1)</script><style>.x{}</style><img data-id="1" src="a.jpg">'
  });

  assert.equal(processed.contentHtml.includes('<script'), false);
  assert.equal(processed.contentHtml.includes('<style'), false);
  assert.equal(processed.contentHtml.includes('onload='), false);
});

test('foodtalks selector table includes required controls', () => {
  assert.ok(Array.isArray(FOODTALKS_SELECTORS.titleInputCandidates));
  assert.ok(Array.isArray(FOODTALKS_SELECTORS.essayButtonCandidates));
  assert.ok(Array.isArray(FOODTALKS_SELECTORS.draftButtonCandidates));
  assert.ok(Array.isArray(FOODTALKS_SELECTORS.publishButtonCandidates));
});

test('foodtalks extractor enables importer only for wechat article urls', () => {
  const wechat = extractFoodtalksContent({
    sourceUrl: 'https://mp.weixin.qq.com/s/demo',
    preferImporter: true
  });
  assert.equal(wechat.sourceType, 'other');
  assert.equal(wechat.preferImporter, false);

  const feishu = extractFoodtalksContent({
    sourceUrl: 'https://foodtalks.feishu.cn/docx/demo',
    preferImporter: true
  });
  assert.equal(feishu.sourceType, 'feishu');
  assert.equal(feishu.preferImporter, false);
});

test('collect image candidates preserves order and deduplicates urls', () => {
  const payload = {
    images: [{ src: 'https://a.test/1.jpg#foo' }, { src: 'https://a.test/2.jpg' }],
    contentHtml:
      '<p>x</p><img src="https://a.test/2.jpg"/><img data-src="https://a.test/3.jpg#imgIndex=1" /><img src="//a.test/4.png" />'
  };

  const urls = collectImageCandidates(payload);
  assert.deepEqual(urls, [
    'https://a.test/1.jpg',
    'https://a.test/2.jpg',
    'https://a.test/3.jpg',
    'https://a.test/4.png'
  ]);
});
