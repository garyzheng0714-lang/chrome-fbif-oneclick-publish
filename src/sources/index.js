import { isFeishuDocUrl, extractFeishuDocByApi } from './feishu/extractor.js';

export const SOURCE_ADAPTERS = [
  {
    id: 'feishu-docx',
    name: '飞书云文档',
    match: (url) => isFeishuDocUrl(url),
    extract: extractFeishuDocByApi
  }
];

export const SOURCE_ADAPTER_MAP = Object.fromEntries(SOURCE_ADAPTERS.map((item) => [item.id, item]));
