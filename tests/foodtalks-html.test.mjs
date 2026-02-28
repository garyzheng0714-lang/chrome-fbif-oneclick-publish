import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildFoodtalksPasteHtml, normalizeUrlForPublish, validatePublishHtmlImages } from '../src/shared/foodtalks-html.js';

function withDom(callback) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  global.DOMParser = dom.window.DOMParser;
  global.HTMLElement = dom.window.HTMLElement;
  global.HTMLImageElement = dom.window.HTMLImageElement;
  global.HTMLParagraphElement = dom.window.HTMLParagraphElement;
  try {
    callback();
  } finally {
    delete global.DOMParser;
    delete global.HTMLElement;
    delete global.HTMLImageElement;
    delete global.HTMLParagraphElement;
  }
}

test('normalizeUrlForPublish supports https/data/protocol-relative', () => {
  assert.equal(normalizeUrlForPublish('https://a.test/1.png'), 'https://a.test/1.png');
  assert.equal(normalizeUrlForPublish('//a.test/1.png'), 'https://a.test/1.png');
  assert.equal(normalizeUrlForPublish('data:image/png;base64,abc'), 'data:image/png;base64,abc');
  assert.equal(normalizeUrlForPublish('javascript:alert(1)'), '');
});

test('buildFoodtalksPasteHtml strips unsafe nodes and preserves image', () => {
  withDom(() => {
    const rawHtml = `
      <h1>标题</h1>
      <script>alert(1)</script>
      <p onclick="x()">正文</p>
      <img data-src="https://a.test/1.png" />
    `;
    const normalized = buildFoodtalksPasteHtml(rawHtml);
    assert.equal(normalized.includes('<script'), false);
    assert.equal(normalized.includes('onclick='), false);
    assert.equal(normalized.includes('https://a.test/1.png'), true);
    assert.equal(normalized.includes('<h2'), true);
  });
});

test('validatePublishHtmlImages counts invalid image src', () => {
  withDom(() => {
    const result = validatePublishHtmlImages('<img src=\"https://a.test/1.png\" /><img src=\"blob:abc\" /><img />');
    assert.equal(result.totalCount, 3);
    assert.equal(result.invalidCount, 2);
  });
});
