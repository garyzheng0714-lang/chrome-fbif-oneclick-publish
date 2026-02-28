import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWechatPasteHtml } from '../src/shared/wechat-html.js';
import {
  buildImageTextRunSignature,
  buildWechatEditorInsertPlan,
  isImageTextRunCompatible
} from '../src/shared/wechat-editor-order.js';

function extractImageSrcOrder(html) {
  const source = String(html || '');
  const result = [];
  const pattern = /<img\b[^>]*\ssrc\s*=\s*(['"])(.*?)\1/gi;
  let match = null;
  while ((match = pattern.exec(source))) {
    result.push(String(match[2] || '').trim());
  }
  return result;
}

function extractSemanticTagSequence(html) {
  const source = String(html || '');
  const result = [];
  const pattern = /<(img|p|h[1-6]|blockquote|ul|ol|li|pre|code)\b/gi;
  let match = null;
  while ((match = pattern.exec(source))) {
    result.push(String(match[1] || '').toLowerCase());
  }
  return result;
}

test('single image in middle keeps paragraph-image-paragraph order', () => {
  const source = [
    '<p>第一段</p>',
    '<figure><img src="https://img.test/1.png" alt="1" /></figure>',
    '<p>第二段</p>'
  ].join('');
  const wechatHtml = buildWechatPasteHtml(source);
  const plan = buildWechatEditorInsertPlan(wechatHtml, {
    maxChunkLength: 64,
    imageDelayMs: 10,
    textYieldEvery: 2
  });
  const rebuilt = plan.map((item) => item.html).join('');

  assert.equal(buildImageTextRunSignature(rebuilt), buildImageTextRunSignature(wechatHtml));
  assert.deepEqual(extractImageSrcOrder(rebuilt), extractImageSrcOrder(wechatHtml));
});

test('multiple images distributed across paragraphs keep original image order', () => {
  const source = [
    '<p>导语段落</p>',
    '<img src="https://img.test/a.jpg" />',
    '<p>中间段落 A</p>',
    '<p>中间段落 B</p>',
    '<img src="https://img.test/b.jpg" />',
    '<p>结尾段落</p>',
    '<img src="https://img.test/c.jpg" />'
  ].join('');
  const wechatHtml = buildWechatPasteHtml(source);
  const plan = buildWechatEditorInsertPlan(wechatHtml, {
    maxChunkLength: 72,
    imageDelayMs: 10,
    textYieldEvery: 3
  });
  const rebuilt = plan.map((item) => item.html).join('');

  assert.deepEqual(extractImageSrcOrder(rebuilt), [
    'https://img.test/a.jpg',
    'https://img.test/b.jpg',
    'https://img.test/c.jpg'
  ]);
  assert.equal(
    isImageTextRunCompatible(
      buildImageTextRunSignature(wechatHtml),
      buildImageTextRunSignature(rebuilt)
    ),
    true
  );
});

test('e2e pipeline keeps mixed formatting around images (quote/list/code)', () => {
  const source = [
    '<blockquote><p>引用段落</p></blockquote>',
    '<p>正文一</p>',
    '<img src="https://img.test/mix-1.jpg" />',
    '<ul><li>列表项一</li><li>列表项二</li></ul>',
    '<pre><code>const x = 1;</code></pre>',
    '<p>正文二</p>',
    '<img src="https://img.test/mix-2.jpg" />'
  ].join('');
  const wechatHtml = buildWechatPasteHtml(source);
  const plan = buildWechatEditorInsertPlan(wechatHtml, {
    maxChunkLength: 80,
    imageDelayMs: 10,
    textYieldEvery: 2
  });
  const rebuilt = plan.map((item) => item.html).join('');

  assert.deepEqual(extractSemanticTagSequence(rebuilt), extractSemanticTagSequence(wechatHtml));
});

test('image run signature detects invalid bottom-stacked images', () => {
  const expected = buildImageTextRunSignature(
    '<p>段落1</p><img src="a"/><p>段落2</p><img src="b"/><p>段落3</p>'
  );
  const broken = buildImageTextRunSignature(
    '<p>段落1</p><p>段落2</p><p>段落3</p><img src="a"/><img src="b"/>'
  );
  assert.equal(isImageTextRunCompatible(expected, broken), false);
});

test('buildWechatEditorInsertPlan uses adaptive delay for normal/data images', () => {
  const html = '<p>段落</p><img src="https://img.test/a.jpg" /><img src="data:image/png;base64,abc123" />';
  const plan = buildWechatEditorInsertPlan(html, {
    maxChunkLength: 64,
    imageDelayMs: 0,
    dataImageDelayMs: 60,
    textYieldEvery: 2
  });
  const imageSteps = plan.filter((item) => item.isImage);
  assert.equal(imageSteps.length >= 2, true);
  assert.equal(imageSteps.some((item) => item.isDataImage && item.delayMs === 60), true);
  assert.equal(imageSteps.some((item) => !item.isDataImage && item.delayMs === 0), true);
});
