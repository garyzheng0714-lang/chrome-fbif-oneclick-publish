import test from 'node:test';
import assert from 'node:assert/strict';
import { inferErrorCode, mapErrorToRecovery } from '../src/shared/error-mapping.js';

test('inferErrorCode maps known error messages', () => {
  assert.equal(inferErrorCode('FT_LOGIN_REQUIRED: 未检测到登录态'), 'FT_LOGIN_REQUIRED');
  assert.equal(inferErrorCode('WX_LOGIN_REQUIRED: 公众号登录已失效'), 'WX_LOGIN_REQUIRED');
  assert.equal(inferErrorCode('WX_EDITOR_NOT_FOUND: 未进入编辑页'), 'WX_EDITOR_NOT_FOUND');
  assert.equal(inferErrorCode('WX_FILL_TITLE_FAILED: 标题填充失败'), 'WX_FILL_TITLE_FAILED');
  assert.equal(inferErrorCode('WX_FILL_CONTENT_FAILED: 正文填充失败'), 'WX_FILL_CONTENT_FAILED');
  assert.equal(inferErrorCode('缺少飞书 App 凭据，请先保存'), 'FEISHU_CREDENTIAL_MISSING');
  assert.equal(inferErrorCode('forbidden: 无权限读取文档'), 'FEISHU_PERMISSION_DENIED');
  assert.equal(inferErrorCode('有 2 张图片未就绪'), 'FEISHU_IMAGE_FETCH_FAILED');
});

test('mapErrorToRecovery returns action metadata', () => {
  const mapped = mapErrorToRecovery('FT_LOGIN_REQUIRED: 需要登录');
  assert.equal(mapped.code, 'FT_LOGIN_REQUIRED');
  assert.equal(mapped.actionType, 'open_login');
  assert.equal(mapped.actionLabel.includes('登录'), true);

  const wechatMapped = mapErrorToRecovery('WX_FILL_CONTENT_FAILED: 正文填充失败');
  assert.equal(wechatMapped.code, 'WX_FILL_CONTENT_FAILED');
  assert.equal(wechatMapped.actionType, 'copy_wechat_html');

  const fallback = mapErrorToRecovery('something unknown');
  assert.equal(fallback.code, 'UNKNOWN');
  assert.equal(fallback.actionType, 'retry');
});
