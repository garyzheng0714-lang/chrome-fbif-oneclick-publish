export function extractFoodtalksContent(content = {}) {
  const sourceUrl = typeof content?.sourceUrl === 'string' ? content.sourceUrl.trim() : '';
  const isFeishuSource = /^https?:\/\/([a-z0-9-]+\.)?feishu\.cn\/docx\//i.test(sourceUrl);

  return {
    ...content,
    sourceUrl,
    sourceType: isFeishuSource ? 'feishu' : sourceUrl ? 'other' : 'unknown',
    publishAction: content?.publishAction === 'publish' ? 'publish' : 'draft',
    preferImporter: false
  };
}
