import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampProgress,
  getActionButtonConfig,
  POPUP_MODES,
  shouldShowReextractButton,
  SYNC_TARGETS,
  WECHAT_SYNC_STATUSES
} from '../src/shared/popup-flow.js';

test('clampProgress keeps number in 0..100', () => {
  assert.equal(clampProgress(-10), 0);
  assert.equal(clampProgress(31.6), 32);
  assert.equal(clampProgress(101), 100);
  assert.equal(clampProgress('bad'), 0);
});

test('getActionButtonConfig returns extracting state first', () => {
  const config = getActionButtonConfig(POPUP_MODES.EXTRACTING, SYNC_TARGETS.FOODTALKS, 48.3);
  assert.deepEqual(config, {
    text: '提取中 48%',
    className: 'btn-primary btn-loading',
    disabled: true
  });
});

test('getActionButtonConfig requires target selected after extract', () => {
  const config = getActionButtonConfig(POPUP_MODES.SYNC, '', 0, { wechatSyncStatus: WECHAT_SYNC_STATUSES.IDLE });
  assert.deepEqual(config, {
    text: '请选择同步目标',
    className: 'btn-secondary',
    disabled: true
  });
});

test('getActionButtonConfig supports wechat sync action', () => {
  const config = getActionButtonConfig(POPUP_MODES.SYNC, SYNC_TARGETS.WECHAT, 0, {
    wechatSyncStatus: WECHAT_SYNC_STATUSES.IDLE
  });
  assert.deepEqual(config, {
    text: '同步到公众号',
    className: 'btn-secondary',
    disabled: false
  });
});

test('getActionButtonConfig disables wechat button when sync is running', () => {
  const config = getActionButtonConfig(POPUP_MODES.SYNC, SYNC_TARGETS.WECHAT, 0, {
    wechatSyncStatus: WECHAT_SYNC_STATUSES.FILLING
  });
  assert.deepEqual(config, {
    text: '公众号同步进行中',
    className: 'btn-secondary',
    disabled: true
  });
});

test('getActionButtonConfig supports copied repeat action', () => {
  const config = getActionButtonConfig(POPUP_MODES.COPIED, SYNC_TARGETS.FOODTALKS);
  assert.deepEqual(config, {
    text: '已复制',
    className: 'btn-copied',
    disabled: false
  });
});

test('shouldShowReextractButton only for sync/copy states', () => {
  assert.equal(shouldShowReextractButton(POPUP_MODES.EXTRACT), false);
  assert.equal(shouldShowReextractButton(POPUP_MODES.EXTRACTING), false);
  assert.equal(shouldShowReextractButton(POPUP_MODES.SYNC), true);
  assert.equal(shouldShowReextractButton(POPUP_MODES.COPIED), true);
});
