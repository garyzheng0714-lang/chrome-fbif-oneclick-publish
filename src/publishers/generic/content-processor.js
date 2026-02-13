export function processGenericContent(payload = {}) {
  return {
    ...payload,
    contentHtml: typeof payload.contentHtml === 'string' ? payload.contentHtml : '',
    textPlain: typeof payload.textPlain === 'string' ? payload.textPlain : ''
  };
}
