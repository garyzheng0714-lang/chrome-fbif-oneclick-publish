import { buildWechatPasteHtml } from '../shared/wechat-html.js';
import {
  getWechatSyncTransferPlan,
  splitSerializedContentForTransfer
} from '../shared/wechat-sync-transfer.js';

const WORKER_MESSAGE_TYPES = Object.freeze({
  PREPARE_WECHAT_SYNC_PAYLOAD: 'PREPARE_WECHAT_SYNC_PAYLOAD'
});

self.addEventListener('message', (event) => {
  const requestId = String(event?.data?.requestId || '').trim();
  if (!requestId) {
    return;
  }

  const type = String(event?.data?.type || '').trim();
  const payload = event?.data?.payload && typeof event.data.payload === 'object' ? event.data.payload : {};

  Promise.resolve()
    .then(() => {
      switch (type) {
        case WORKER_MESSAGE_TYPES.PREPARE_WECHAT_SYNC_PAYLOAD:
          return prepareWechatSyncPayload(payload);
        default:
          throw new Error(`不支持的 worker 消息类型：${type}`);
      }
    })
    .then((result) => {
      self.postMessage({
        requestId,
        ok: true,
        result
      });
    })
    .catch((error) => {
      self.postMessage({
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
});

function prepareWechatSyncPayload(payload = {}) {
  const sourceHtml = String(payload?.sourceHtml || '').trim();
  if (!sourceHtml) {
    throw new Error('公众号正文生成失败');
  }

  const title = String(payload?.title || '').trim();
  const templateId = String(payload?.templateId || '').trim();

  const contentHtml = buildWechatPasteHtml(sourceHtml, {
    templateId
  });
  if (!contentHtml) {
    throw new Error('公众号正文生成失败');
  }

  const serializedContent = JSON.stringify({
    title,
    contentHtml,
    templateId
  });

  const transferPlan = getWechatSyncTransferPlan(serializedContent, payload?.transferOptions || {});
  const chunks =
    transferPlan.mode === 'chunked'
      ? splitSerializedContentForTransfer(serializedContent, payload?.transferOptions || {})
      : [];

  return {
    title,
    contentHtml,
    templateId,
    serializedContent: transferPlan.mode === 'direct' ? serializedContent : '',
    transferPlan,
    chunks
  };
}
