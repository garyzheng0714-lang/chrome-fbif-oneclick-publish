import test from 'node:test';
import assert from 'node:assert/strict';

import { extractWechatSyncTransferPayload } from '../src/shared/wechat-sync-payload.js';

test('extractWechatSyncTransferPayload: direct payload', () => {
  const payload = {
    title: '测试标题',
    contentHtml: '<p>正文</p>',
    templateId: 'tmpl_a'
  };

  assert.deepEqual(extractWechatSyncTransferPayload(payload), {
    title: '测试标题',
    contentHtml: '<p>正文</p>',
    templateId: 'tmpl_a'
  });
});

test('extractWechatSyncTransferPayload: legacy nested payload', () => {
  const payload = {
    payload: {
      data: {
        title: '旧结构标题',
        html: '<p>旧结构正文</p>',
        templateId: 'tmpl_legacy'
      }
    }
  };

  assert.deepEqual(extractWechatSyncTransferPayload(payload), {
    title: '旧结构标题',
    contentHtml: '<p>旧结构正文</p>',
    templateId: 'tmpl_legacy'
  });
});

test('extractWechatSyncTransferPayload: json string payload', () => {
  const payload = JSON.stringify({
    title: '字符串标题',
    contentHtml: '<p>字符串正文</p>'
  });

  assert.deepEqual(extractWechatSyncTransferPayload(payload), {
    title: '字符串标题',
    contentHtml: '<p>字符串正文</p>',
    templateId: ''
  });
});

test('extractWechatSyncTransferPayload: double encoded payload string', () => {
  const payload = JSON.stringify(
    JSON.stringify({
      data: {
        title: '双层字符串标题',
        contentHtml: '<p>双层字符串正文</p>'
      }
    })
  );

  assert.deepEqual(extractWechatSyncTransferPayload(payload), {
    title: '双层字符串标题',
    contentHtml: '<p>双层字符串正文</p>',
    templateId: ''
  });
});

test('extractWechatSyncTransferPayload: raw html string', () => {
  const payload = '<p>纯 HTML 正文</p>';
  assert.deepEqual(extractWechatSyncTransferPayload(payload), {
    title: '',
    contentHtml: '<p>纯 HTML 正文</p>',
    templateId: ''
  });
});

test('extractWechatSyncTransferPayload: empty payload', () => {
  assert.deepEqual(extractWechatSyncTransferPayload({}), {
    title: '',
    contentHtml: '',
    templateId: ''
  });
});

