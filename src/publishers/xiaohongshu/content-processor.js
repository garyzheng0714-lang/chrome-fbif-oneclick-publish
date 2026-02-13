export function processXiaohongshuContent(payload = {}) {
  const contentHtml = typeof payload.contentHtml === 'string' ? payload.contentHtml : '';
  const compact = contentHtml
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\sdata-[a-z-]+="[^"]*"/gi, '')
    .trim();

  return {
    ...payload,
    contentHtml: compact
  };
}
