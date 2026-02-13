import { processGenericImages } from '../generic/image-processor.js';

export async function processPlatformImages(payload = {}) {
  return processGenericImages(payload);
}
