function toMessage(input) {
  return String(input || '').trim();
}

export function inferErrorCode(rawMessage) {
  const message = toMessage(rawMessage).toLowerCase();

  if (!message) return 'UNKNOWN';
  if (message.includes('ft_login_required') || message.includes('未检测到登录态') || message.includes('需要登录')) {
    return 'FT_LOGIN_REQUIRED';
  }
  if (message.includes('wx_login_required') || message.includes('公众号登录')) {
    return 'WX_LOGIN_REQUIRED';
  }
  if (message.includes('wx_editor_not_found') || message.includes('编辑页')) {
    return 'WX_EDITOR_NOT_FOUND';
  }
  if (message.includes('wx_fill_title_failed') || message.includes('标题填充')) {
    return 'WX_FILL_TITLE_FAILED';
  }
  if (message.includes('wx_fill_content_failed') || message.includes('正文填充')) {
    return 'WX_FILL_CONTENT_FAILED';
  }
  if (message.includes('缺少飞书 app 凭据') || message.includes('缺少飞书凭据') || message.includes('credential')) {
    return 'FEISHU_CREDENTIAL_MISSING';
  }
  if (message.includes('添加应用') || message.includes('permission') || message.includes('forbidden') || message.includes('无权限')) {
    return 'FEISHU_PERMISSION_DENIED';
  }
  if (message.includes('图片') && (message.includes('失败') || message.includes('未就绪'))) {
    return 'FEISHU_IMAGE_FETCH_FAILED';
  }
  if (message.includes('链接') && message.includes('仅支持飞书')) {
    return 'SOURCE_URL_INVALID';
  }

  return 'UNKNOWN';
}

export function mapErrorToRecovery(rawMessage, explicitCode = '') {
  const code = explicitCode || inferErrorCode(rawMessage);
  const message = toMessage(rawMessage) || '未知错误';

  const map = {
    FT_LOGIN_REQUIRED: {
      actionType: 'open_login',
      actionLabel: '打开登录页并等待检测完成'
    },
    WX_LOGIN_REQUIRED: {
      actionType: 'open_wechat_login',
      actionLabel: '打开公众号后台并完成登录'
    },
    WX_EDITOR_NOT_FOUND: {
      actionType: 'open_wechat_editor',
      actionLabel: '进入公众号图文编辑页'
    },
    WX_FILL_TITLE_FAILED: {
      actionType: 'retry_wechat_fill',
      actionLabel: '重试公众号标题填充'
    },
    WX_FILL_CONTENT_FAILED: {
      actionType: 'copy_wechat_html',
      actionLabel: '复制 HTML 正文后手动粘贴'
    },
    FEISHU_CREDENTIAL_MISSING: {
      actionType: 'open_credentials',
      actionLabel: '填写飞书凭据'
    },
    FEISHU_PERMISSION_DENIED: {
      actionType: 'regrant_permission',
      actionLabel: '为文档重新授权'
    },
    FEISHU_IMAGE_FETCH_FAILED: {
      actionType: 'reextract',
      actionLabel: '重新提取并拉图'
    },
    SOURCE_URL_INVALID: {
      actionType: 'focus_url',
      actionLabel: '修正来源链接'
    },
    UNKNOWN: {
      actionType: 'retry',
      actionLabel: '重试当前步骤'
    }
  };

  const recovery = map[code] || map.UNKNOWN;
  return {
    code,
    message,
    actionType: recovery.actionType,
    actionLabel: recovery.actionLabel
  };
}
