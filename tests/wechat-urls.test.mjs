import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WECHAT_MP_HOME_URL,
  buildWechatEditorUrl,
  getWechatMpToken,
  isWechatEditorUrl,
  isWechatMpUrl
} from '../src/publishers/shared/wechat-urls.js';

test('wechat url helpers identify mp domain and token', () => {
  assert.equal(isWechatMpUrl(WECHAT_MP_HOME_URL), true);
  assert.equal(isWechatMpUrl('https://admin-we.foodtalks.cn/#/login'), false);

  assert.equal(getWechatMpToken('https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=123456'), '123456');
  assert.equal(getWechatMpToken('https://mp.weixin.qq.com/'), '');
});

test('wechat editor url helper works for supported shapes', () => {
  assert.equal(
    isWechatEditorUrl('https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&isNew=1&token=123456'),
    true
  );
  assert.equal(isWechatEditorUrl('https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=123456'), false);
});

test('buildWechatEditorUrl keeps required query fields and optional token', () => {
  const withoutToken = buildWechatEditorUrl('');
  assert.equal(withoutToken.startsWith('https://mp.weixin.qq.com/cgi-bin/appmsg?'), true);
  assert.equal(withoutToken.includes('media%2Fappmsg_edit_v2'), true);

  const withToken = buildWechatEditorUrl('123456');
  assert.equal(withToken.includes('token=123456'), true);
});
