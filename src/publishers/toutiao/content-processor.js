import { processGenericContent } from '../generic/content-processor.js';

export function processPlatformContent(payload = {}) {
  return processGenericContent(payload);
}
