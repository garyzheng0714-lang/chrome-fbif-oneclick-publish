export const POPUP_MODES = Object.freeze({
  EXTRACT: 'extract',
  EXTRACTING: 'extracting',
  SYNC: 'sync',
  COPIED: 'copied'
});

export const SYNC_TARGETS = Object.freeze({
  FOODTALKS: 'foodtalks',
  WECHAT: 'wechat'
});

export const WECHAT_SYNC_STATUSES = Object.freeze({
  IDLE: 'idle',
  WAITING_LOGIN: 'waiting_login',
  WAITING_EDITOR: 'waiting_editor',
  FILLING: 'filling',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export function clampProgress(percent) {
  const numeric = Number(percent);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function isWechatSyncBusy(status) {
  return (
    status === WECHAT_SYNC_STATUSES.WAITING_LOGIN ||
    status === WECHAT_SYNC_STATUSES.WAITING_EDITOR ||
    status === WECHAT_SYNC_STATUSES.FILLING
  );
}

export function getActionButtonConfig(mode, target, progress = 0, options = {}) {
  const targetSelected = Boolean(target) && (target === SYNC_TARGETS.FOODTALKS || target === SYNC_TARGETS.WECHAT);
  const wechatSyncStatus = String(options?.wechatSyncStatus || WECHAT_SYNC_STATUSES.IDLE);

  if (mode === POPUP_MODES.EXTRACTING) {
    const percent = clampProgress(progress);
    return {
      text: `提取中 ${percent}%`,
      className: 'btn-primary btn-loading',
      disabled: true
    };
  }

  if (mode === POPUP_MODES.EXTRACT) {
    return {
      text: '提取飞书云文档内容',
      className: 'btn-primary',
      disabled: false
    };
  }

  if (!targetSelected) {
    return {
      text: '请选择同步目标',
      className: 'btn-secondary',
      disabled: true
    };
  }

  if (target === SYNC_TARGETS.WECHAT) {
    if (isWechatSyncBusy(wechatSyncStatus)) {
      return {
        text: '公众号同步进行中',
        className: 'btn-secondary',
        disabled: true
      };
    }

    if (wechatSyncStatus === WECHAT_SYNC_STATUSES.DONE) {
      return {
        text: '重新同步公众号',
        className: 'btn-secondary',
        disabled: false
      };
    }

    if (wechatSyncStatus === WECHAT_SYNC_STATUSES.FAILED || wechatSyncStatus === WECHAT_SYNC_STATUSES.CANCELLED) {
      return {
        text: '重试同步公众号',
        className: 'btn-secondary',
        disabled: false
      };
    }

    return {
      text: '同步到公众号',
      className: 'btn-secondary',
      disabled: false
    };
  }

  if (mode === POPUP_MODES.COPIED) {
    return {
      text: '已复制',
      className: 'btn-copied',
      disabled: false
    };
  }

  return {
    text: '同步到 FoodTalks',
    className: 'btn-primary',
    disabled: false
  };
}

export function shouldShowReextractButton(mode) {
  return mode === POPUP_MODES.SYNC || mode === POPUP_MODES.COPIED;
}
