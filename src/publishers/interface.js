/**
 * 标准平台适配器接口（Platform Adapter Interface）
 *
 * 每个平台应提供：
 * - extractor: 提取/归一化输入内容
 * - contentProcessor: 平台正文结构处理
 * - imageProcessor: 平台图片处理策略
 * - publishApi: 页面注入发布逻辑
 */

/**
 * @typedef {Object} PlatformRuntime
 * @property {(payload: { tabId: number, func: Function, args?: any[], timeoutMs?: number }) => Promise<any>} executeInTab
 * @property {(promise: Promise<any>, timeoutMs: number, timeoutMessage: string) => Promise<any>} withTimeout
 */

/**
 * @typedef {Object} PlatformAdapter
 * @property {string} id
 * @property {string} name
 * @property {string} publishUrl
 * @property {(content: any) => any} extractor
 * @property {(payload: any) => any} contentProcessor
 * @property {(payload: any) => Promise<any>|any} imageProcessor
 * @property {(ctx: { tabId: number, payload: any, runtime: PlatformRuntime }) => Promise<{ ok: boolean, warnings?: string[], detail?: any, error?: string }> } publishApi
 */

export {};
