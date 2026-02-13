export function extractGenericContent(content = {}) {
  return {
    title: typeof content.title === 'string' ? content.title.trim() : '',
    coverUrl: typeof content.coverUrl === 'string' ? content.coverUrl.trim() : '',
    contentHtml: typeof content.contentHtml === 'string' ? content.contentHtml : '',
    textPlain: typeof content.textPlain === 'string' ? content.textPlain.trim() : '',
    images: Array.isArray(content.images)
      ? content.images
          .map((item, index) => ({ index, src: typeof item?.src === 'string' ? item.src : '' }))
          .filter((item) => item.src)
      : []
  };
}
