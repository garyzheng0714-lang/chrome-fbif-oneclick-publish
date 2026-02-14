const DROP_TAGS = /<(script|style|iframe|meta|link|noscript)(\s[^>]*)?>[\s\S]*?<\/\1>/gi;

function stripDangerousAttributes(html) {
  return String(html || '').replace(/\s(on\w+)=(["']).*?\2/gi, '');
}

export function processFoodtalksContent(payload = {}) {
  const contentHtml = stripDangerousAttributes(String(payload.contentHtml || '').replace(DROP_TAGS, '')).trim();

  return {
    ...payload,
    contentHtml,
    textPlain:
      typeof payload.textPlain === 'string' && payload.textPlain.trim()
        ? payload.textPlain.trim()
        : contentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  };
}
