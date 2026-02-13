export function processZhihuContent(payload = {}) {
  const contentHtml = typeof payload.contentHtml === 'string' ? payload.contentHtml : '';

  // 先在 service worker 侧做轻量归一化，重处理在页面上下文中完成。
  const normalized = contentHtml
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\sdata-[a-z-]+="[^"]*"/gi, '')
    .trim();

  return {
    ...payload,
    contentHtml: normalized
  };
}
