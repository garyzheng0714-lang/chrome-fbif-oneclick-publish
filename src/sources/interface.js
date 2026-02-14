/**
 * 标准内容源提取接口（Source Adapter Interface）
 *
 * 每个来源模块建议提供：
 * - match(url): 判断是否匹配该来源
 * - extract(payload): 执行提取并输出标准化文章对象
 */

/**
 * @typedef {Object} SourceCredentials
 * @property {string} appId
 * @property {string} appSecret
 */

/**
 * @typedef {Object} ExtractedArticle
 * @property {string} sourceUrl
 * @property {string} title
 * @property {string} coverUrl
 * @property {string} contentHtml
 * @property {string} textPlain
 * @property {number} wordCount
 * @property {number} paragraphCount
 * @property {number} imageCount
 * @property {Array<{ index: number, src: string, alt?: string, token?: string, blockId?: string }>} images
 * @property {string[]} [validationHints]
 */

export {};
