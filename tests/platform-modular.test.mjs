import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_ADAPTERS } from '../src/publishers/index.js';
import { processZhihuContent } from '../src/publishers/zhihu/content-processor.js';
import { processXiaohongshuContent } from '../src/publishers/xiaohongshu/content-processor.js';
import { PLATFORM_SPECS } from '../src/publishers/shared/platform-specs.js';
import { collectImageCandidates } from '../src/publishers/shared/image-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const REQUIRED_FILES = ['extractor.js', 'content-processor.js', 'image-processor.js', 'publish-api.js'];

test('platform adapters expose standardized interface', () => {
  assert.ok(Array.isArray(PLATFORM_ADAPTERS));
  assert.ok(PLATFORM_ADAPTERS.length >= 5);

  for (const adapter of PLATFORM_ADAPTERS) {
    assert.ok(adapter.id);
    assert.ok(adapter.name);
    assert.ok(adapter.publishUrl);
    assert.equal(typeof adapter.extractor, 'function');
    assert.equal(typeof adapter.contentProcessor, 'function');
    assert.equal(typeof adapter.imageProcessor, 'function');
    assert.equal(typeof adapter.publishApi, 'function');
  }
});

test('each platform folder includes extractor/processor/image/publish files', () => {
  for (const adapter of PLATFORM_ADAPTERS) {
    const folder = path.join(rootDir, 'src', 'publishers', adapter.id);
    assert.equal(fs.existsSync(folder), true, `${adapter.id} folder missing`);

    for (const file of REQUIRED_FILES) {
      assert.equal(fs.existsSync(path.join(folder, file)), true, `${adapter.id}/${file} missing`);
    }
  }
});

test('zhihu content processor strips unsafe payloads', () => {
  const processed = processZhihuContent({
    contentHtml: '<p>Hello</p><script>alert(1)</script><style>.x{}</style><img data-id="1" src="a.jpg">'
  });

  assert.equal(processed.contentHtml.includes('<script'), false);
  assert.equal(processed.contentHtml.includes('<style'), false);
  assert.equal(processed.contentHtml.includes('data-id='), false);
});

test('xiaohongshu content processor strips unsafe payloads', () => {
  const processed = processXiaohongshuContent({
    contentHtml: '<p>Hello</p><script>alert(1)</script><style>.x{}</style><div data-id="x">ok</div>'
  });

  assert.equal(processed.contentHtml.includes('<script'), false);
  assert.equal(processed.contentHtml.includes('<style'), false);
  assert.equal(processed.contentHtml.includes('data-id='), false);
});

test('platform selector table is registered for zhihu/xiaohongshu', () => {
  assert.equal(PLATFORM_SPECS.zhihu.publishUrl, 'https://zhuanlan.zhihu.com/write');
  assert.ok(Array.isArray(PLATFORM_SPECS.zhihu.titleSelectors));
  assert.ok(Array.isArray(PLATFORM_SPECS.xiaohongshu.editorSelectors));
  assert.ok(Array.isArray(PLATFORM_SPECS.xiaohongshu.imageInputSelectors));
});

test('collect image candidates preserves order and deduplicates urls', () => {
  const payload = {
    images: [
      { src: 'https://a.test/1.jpg#foo' },
      { src: 'https://a.test/2.jpg' }
    ],
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
