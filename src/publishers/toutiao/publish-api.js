import { publishGenericByAutofill } from '../generic/publish-api.js';

export async function publishPlatform(ctx) {
  return publishGenericByAutofill(ctx);
}
