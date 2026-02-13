import { prepareImagesForUpload } from '../shared/image-fetch.js';
import { PLATFORM_SPECS } from '../shared/platform-specs.js';

const XHS_IMAGE_TIMEOUT_MS = 18_000;
const XHS_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const XHS_MAX_TRANSFER_BYTES = 8 * 1024 * 1024;

export async function processXiaohongshuImages(payload = {}) {
  const spec = PLATFORM_SPECS.xiaohongshu;
  const preparation = await prepareImagesForUpload(payload, {
    maxCount: spec.maxImages,
    timeoutMs: XHS_IMAGE_TIMEOUT_MS,
    maxBytes: XHS_IMAGE_MAX_BYTES
  });

  const preparedImages = [];
  let transferBytes = 0;

  for (const item of preparation.prepared) {
    if (!item?.dataUrl) continue;
    const estimatedBytes = Math.ceil((item.dataUrl.length * 3) / 4);
    if (transferBytes + estimatedBytes > XHS_MAX_TRANSFER_BYTES) {
      break;
    }
    transferBytes += estimatedBytes;
    preparedImages.push(item);
  }

  const skippedCount = preparation.prepared.length - preparedImages.length;
  const effectiveFailedCount = preparation.failed.length + Math.max(0, skippedCount);

  return {
    ...payload,
    imageStrategy: 'file-input-upload',
    preparedImages: preparedImages.map((item) => ({
      name: item.name,
      type: item.type,
      size: item.size,
      sourceUrl: item.sourceUrl,
      dataUrl: item.dataUrl
    })),
    imagePreparation: {
      requestedCount: preparation.candidates.length,
      preparedCount: preparedImages.length,
      failedCount: effectiveFailedCount,
      failed: [
        ...preparation.failed.map((item) => ({
          sourceUrl: item.sourceUrl,
          error: item.error,
          size: item.size
        })),
        ...preparation.prepared.slice(preparedImages.length).map((item) => ({
          sourceUrl: item.sourceUrl,
          error: 'image-transfer-size-limit',
          size: item.size
        }))
      ],
      transferBytes
    }
  };
}
