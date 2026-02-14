import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PLATFORM_DEFINITIONS } from '../src/platforms.js';

test('platform definitions include foodtalks only', () => {
  const ids = PLATFORM_DEFINITIONS.map((item) => item.id);
  assert.deepEqual(ids, ['foodtalks']);
});

test('extract images in DOM order and preserve src', () => {
  const html = `
    <article>
      <p>A</p>
      <img src="https://a.test/1.jpg" />
      <p>B</p>
      <img data-src="https://a.test/2.jpg" src="" />
      <p>C</p>
      <img src="https://a.test/3.jpg" />
    </article>
  `;

  const dom = new JSDOM(html);
  const images = [...dom.window.document.querySelectorAll('img')].map((img, index) => ({
    index,
    src: img.getAttribute('data-src') || img.getAttribute('src') || ''
  }));

  assert.equal(images.length, 3);
  assert.equal(images[0].src, 'https://a.test/1.jpg');
  assert.equal(images[1].src, 'https://a.test/2.jpg');
  assert.equal(images[2].src, 'https://a.test/3.jpg');
});

test('strip html keeps readable text', () => {
  const html = '<h1>标题</h1><p>第一段</p><p><strong>第二段</strong></p>';
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(text, '标题 第一段 第二段');
});
