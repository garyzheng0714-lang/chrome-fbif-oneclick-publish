import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWechatTemplate,
  buildWechatPasteHtml,
  sanitizeWechatPublishHtml
} from '../src/shared/wechat-html.js';

test('sanitizeWechatPublishHtml strips unsupported tags and event attributes', () => {
  const raw = `<p onclick="x()">hello</p><script>alert(1)</script><img src="//foo.bar/a.png" onerror="bad()" />`;
  const html = sanitizeWechatPublishHtml(raw);
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('onclick='), false);
  assert.equal(html.includes('onerror='), false);
  assert.equal(html.includes('https://foo.bar/a.png'), true);
});

test('sanitizeWechatPublishHtml keeps caption font size at 12px', () => {
  const raw = `<figure><img src="https://foo.bar/a.png" /><figcaption>说明</figcaption></figure>`;
  const html = sanitizeWechatPublishHtml(raw);
  assert.equal(html.includes('font-size:12px'), true);
});

test('sanitizeWechatPublishHtml normalizes image caption to plain wechat style', () => {
  const raw =
    '<figure><img src="https://foo.bar/a.png" /><figcaption><p style="background:#fff;border-radius:12px;padding:12px;"><mark>上海新天地新愿集市</mark></p></figcaption></figure>';
  const html = sanitizeWechatPublishHtml(raw);
  assert.equal(html.includes('font-size:12px'), true);
  assert.equal(html.includes('border-radius:12px'), false);
  assert.equal(html.includes('<mark'), false);
  assert.equal(html.includes('上海新天地新愿集市'), true);
});

test('sanitizeWechatPublishHtml keeps block structure styles for heading/list/quote', () => {
  const raw = `<h2>二级标题</h2><ul><li>点1</li></ul><blockquote>引用</blockquote>`;
  const html = sanitizeWechatPublishHtml(raw);
  assert.equal(html.includes('<h2'), true);
  assert.equal(html.includes('line-height:1.5'), true);
  assert.equal(html.includes('<ul'), true);
  assert.equal(html.includes('margin:0 0 14px 1.4em'), true);
  assert.equal(html.includes('<blockquote'), true);
  assert.equal(html.includes('border-left:3px solid #d0d7e2'), true);
});

test('applyWechatTemplate wraps content when template exists', () => {
  const html = applyWechatTemplate('<p>正文</p>', 'news', {
    news: {
      prefixHtml: '<section>头部</section>',
      suffixHtml: '<section>尾部</section>'
    }
  });
  assert.equal(html.includes('头部'), true);
  assert.equal(html.includes('正文'), true);
  assert.equal(html.includes('尾部'), true);
});

test('buildWechatPasteHtml returns empty for empty input', () => {
  assert.equal(buildWechatPasteHtml(''), '');
});
