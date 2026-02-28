import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { demoteHeadingsByOneLevel } from '../src/publishers/shared/heading-normalizer.js';

test('demoteHeadingsByOneLevel demotes heading tags and preserves attributes', () => {
  const dom = new JSDOM(`
    <body>
      <h1 id="main" style="text-align:left;">用途</h1>
      <h2 data-key="usage">用法</h2>
      <h6 id="keep">末级标题</h6>
    </body>
  `);
  const body = dom.window.document.body;

  demoteHeadingsByOneLevel(body);

  const headings = [...body.querySelectorAll('h2,h3,h6')];
  assert.equal(headings.length, 3);
  assert.equal(headings[0].tagName, 'H2');
  assert.equal(headings[0].id, 'main');
  assert.equal(headings[0].getAttribute('style'), 'text-align:left;');
  assert.equal(headings[0].textContent, '用途');

  assert.equal(headings[1].tagName, 'H3');
  assert.equal(headings[1].getAttribute('data-key'), 'usage');
  assert.equal(headings[1].textContent, '用法');

  assert.equal(headings[2].tagName, 'H6');
  assert.equal(headings[2].id, 'keep');
  assert.equal(headings[2].textContent, '末级标题');
});

test('demoteHeadingsByOneLevel applies a single-step demotion', () => {
  const dom = new JSDOM('<body><h1>一级</h1></body>');
  const body = dom.window.document.body;

  demoteHeadingsByOneLevel(body);

  const heading = body.querySelector('h2');
  assert.ok(heading);
  assert.equal(body.querySelector('h3'), null);
  assert.equal(heading.textContent, '一级');
});
