export async function processGenericImages(payload = {}) {
  return {
    ...payload,
    images: Array.isArray(payload.images) ? payload.images : []
  };
}
