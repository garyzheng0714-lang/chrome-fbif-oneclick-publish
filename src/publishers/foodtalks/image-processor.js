import { collectImageCandidates } from '../shared/image-fetch.js';

export async function processFoodtalksImages(payload = {}) {
  const imageUrls = collectImageCandidates(payload);
  return {
    ...payload,
    imageUrls,
    imageCount: imageUrls.length
  };
}
