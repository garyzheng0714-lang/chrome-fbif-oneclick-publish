import { PLATFORM_ADAPTER_MAP } from './src/publishers/index.js';
import {
  downloadFeishuImageAsDataUrl,
  extractFeishuDocByApi,
  isFeishuDocUrl
} from './src/sources/feishu/extractor.js';

const APP_PAGE_URL = chrome.runtime.getURL('app.html');
const FALLBACK_PAGE_URL = chrome.runtime.getURL('fallback.html');

const LOG_KEY = 'fbif_logs_v1';
const CACHE_KEY = 'fbif_cache_v1';
const FAILED_DRAFT_KEY = 'fbif_failed_drafts_v1';
const SOURCE_SETTINGS_KEY = 'fbif_source_settings_v1';

const EXTRACTION_TIMEOUT_MS = 45_000;
const TAB_LOAD_TIMEOUT_MS = 35_000;
const EXTRACTION_RETRY_LIMIT = 2;
const PUBLISH_RETRY_LIMIT = 2;
const LOGIN_WAIT_TIMEOUT_MS = 180_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ITEMS = 20;
const MAX_LOG_ITEMS = 400;
const MAX_FAILED_DRAFTS = 50;
const MAX_FEISHU_IMAGE_CACHE_ITEMS = 80;
const FEISHU_IMAGE_FETCH_RETRY_LIMIT = 8;
const FEISHU_IMAGE_FETCH_RETRY_BASE_DELAY_MS = 900;
const CONTENT_TRANSFER_TTL_MS = 10 * 60 * 1000;
const MAX_CONTENT_TRANSFERS = 8;
const DEFAULT_FEISHU_APP_ID = 'cli_a9f7f8703778dcee';
const DEFAULT_FEISHU_APP_SECRET = 'iqMX8dolH5aObUzgM18MQbtWvtfwKymM';

const feishuImageDataUrlCache = new Map();
const contentTransferStore = new Map();

const PLATFORMS = Object.fromEntries(
  Object.values(PLATFORM_ADAPTER_MAP).map((adapter) => [
    adapter.id,
    {
      id: adapter.id,
      name: adapter.name,
      publishUrl: adapter.publishUrl
    }
  ])
);

chrome.runtime.onInstalled.addListener(() => {
  appendLog('info', 'system', '扩展已安装，可通过工具栏弹窗快速提取飞书内容').catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});

async function handleRuntimeMessage(message, sender) {
  switch (message?.type) {
    case 'OPEN_DISTRIBUTION_PAGE': {
      await chrome.tabs.create({ url: APP_PAGE_URL });
      return { opened: true };
    }
    case 'EXTRACT_ARTICLE': {
      const data = await extractArticle({
        ...(message?.payload ?? {}),
        sourceTabId: sender?.tab?.id ?? null
      });
      return { data };
    }
    case 'PUBLISH_CONTENT': {
      return await publishContent({
        ...(message?.payload ?? {}),
        sourceTabId: sender?.tab?.id ?? null
      });
    }
    case 'BEGIN_CONTENT_TRANSFER': {
      const transfer = beginContentTransfer(message?.payload || {});
      return transfer;
    }
    case 'APPEND_CONTENT_CHUNK': {
      return appendContentChunk(message?.payload || {});
    }
    case 'CLEAR_CONTENT_TRANSFER': {
      clearContentTransfer(message?.payload?.transferId);
      return { cleared: true };
    }
    case 'GET_LOGS': {
      const logs = await readLogs();
      return { logs };
    }
    case 'CLEAR_LOGS': {
      await chrome.storage.local.set({ [LOG_KEY]: [] });
      return { cleared: true };
    }
    case 'GET_FAILED_DRAFTS': {
      return { drafts: await readFailedDrafts() };
    }
    case 'GET_SOURCE_SETTINGS': {
      return { settings: await getSourceSettings() };
    }
    case 'SAVE_SOURCE_SETTINGS': {
      const settings = await saveSourceSettings(message?.payload || {});
      return { settings };
    }
    case 'FETCH_FEISHU_IMAGE': {
      const data = await fetchFeishuImageDataUrl(message?.payload || {});
      return data;
    }
    default:
      throw new Error('不支持的消息类型');
  }
}

function cleanupExpiredContentTransfers() {
  const now = Date.now();
  for (const [transferId, transfer] of contentTransferStore.entries()) {
    if (!transfer || now - transfer.createdAt > CONTENT_TRANSFER_TTL_MS) {
      contentTransferStore.delete(transferId);
    }
  }
}

function beginContentTransfer(payload = {}) {
  cleanupExpiredContentTransfers();

  const transferId = String(payload.transferId || '').trim();
  const totalChunks = Math.max(1, Number(payload.totalChunks) || 0);
  const contentSize = Math.max(0, Number(payload.contentSize) || 0);
  if (!transferId) {
    throw new Error('transferId 缺失');
  }
  if (!Number.isFinite(totalChunks) || totalChunks < 1) {
    throw new Error('内容分片数量无效');
  }

  if (!contentTransferStore.has(transferId) && contentTransferStore.size >= MAX_CONTENT_TRANSFERS) {
    const firstKey = contentTransferStore.keys().next().value;
    if (firstKey) {
      contentTransferStore.delete(firstKey);
    }
  }

  contentTransferStore.set(transferId, {
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalChunks,
    contentSize,
    chunks: new Array(totalChunks).fill(null),
    receivedCount: 0
  });

  return { transferId, totalChunks };
}

function appendContentChunk(payload = {}) {
  cleanupExpiredContentTransfers();

  const transferId = String(payload.transferId || '').trim();
  const chunkIndex = Number(payload.index);
  const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';

  const transfer = contentTransferStore.get(transferId);
  if (!transfer) {
    throw new Error('内容传输会话不存在或已过期');
  }

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= transfer.totalChunks) {
    throw new Error('分片序号无效');
  }

  if (!chunk.length) {
    throw new Error('分片内容为空');
  }

  if (!transfer.chunks[chunkIndex]) {
    transfer.receivedCount += 1;
  }

  transfer.chunks[chunkIndex] = chunk;
  transfer.updatedAt = Date.now();
  contentTransferStore.set(transferId, transfer);

  return {
    transferId,
    index: chunkIndex,
    receivedCount: transfer.receivedCount,
    totalChunks: transfer.totalChunks
  };
}

function clearContentTransfer(transferId) {
  const normalizedId = String(transferId || '').trim();
  if (!normalizedId) return;
  contentTransferStore.delete(normalizedId);
}

function consumeTransferredContent(transferId) {
  cleanupExpiredContentTransfers();

  const normalizedId = String(transferId || '').trim();
  if (!normalizedId) {
    throw new Error('contentTransferId 缺失');
  }

  const transfer = contentTransferStore.get(normalizedId);
  if (!transfer) {
    throw new Error('大内容传输会话不存在或已过期，请重新同步');
  }

  if (transfer.receivedCount !== transfer.totalChunks || transfer.chunks.some((chunk) => typeof chunk !== 'string')) {
    throw new Error('内容分片不完整，请重试同步');
  }

  const serialized = transfer.chunks.join('');
  contentTransferStore.delete(normalizedId);

  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error('内容分片解析失败，请重新同步');
  }
}

async function extractArticle({
  url,
  manualSelector = '',
  forceRefresh = false,
  sourceSettings = null,
  followTabs = true,
  sourceTabId = null
}) {
  if (!url || typeof url !== 'string') {
    throw new Error('请输入公众号或飞书文档链接');
  }

  const normalizedUrl = url.trim();
  if (!isSupportedSourceUrl(normalizedUrl)) {
    throw new Error('链接格式无效，仅支持 mp.weixin.qq.com 或飞书文档（*.feishu.cn/docx|wiki、*.larkoffice.com/docx|wiki）');
  }

  if (!forceRefresh) {
    const cached = await getCachedExtraction(normalizedUrl);
    if (cached) {
      await appendLog('info', 'extract', '命中缓存，跳过重复提取', { url: normalizedUrl });
      return { ...cached, cached: true };
    }
  }

  let lastError;

  for (let attempt = 1; attempt <= EXTRACTION_RETRY_LIMIT; attempt += 1) {
    try {
      await appendLog('info', 'extract', `开始提取内容（第 ${attempt} 次）`, {
        url: normalizedUrl,
        manualSelector
      });

      const sourceType = isFeishuDocUrl(normalizedUrl) ? 'feishu' : 'wechat';
      const rawData = await withTimeout(
        sourceType === 'feishu'
          ? extractFeishuWithFallback({
              url: normalizedUrl,
              manualSelector,
              sourceSettings,
              followTabs,
              sourceTabId
            })
          : extractByTabInjection(normalizedUrl, manualSelector, { followTabs, sourceTabId }),
        EXTRACTION_TIMEOUT_MS,
        '内容提取超时，请检查网络后重试'
      );

      const validation = evaluateExtractionIntegrity(rawData);
      const data = {
        ...rawData,
        sourceUrl: normalizedUrl,
        validation,
        extractedAt: new Date().toISOString()
      };

      await setCachedExtraction(normalizedUrl, data);
      await appendLog('info', 'extract', '提取完成', {
        url: normalizedUrl,
        words: data.wordCount,
        images: data.imageCount,
        warnings: validation.warnings.length
      });

      return { ...data, cached: false };
    } catch (error) {
      lastError = error;
      await appendLog('warn', 'extract', `提取失败（第 ${attempt} 次）`, {
        url: normalizedUrl,
        error: error instanceof Error ? error.message : String(error)
      });

      if (attempt < EXTRACTION_RETRY_LIMIT) {
        await delay(1200 * attempt);
      }
    }
  }

  throw lastError ?? new Error('提取失败，请稍后重试');
}

async function extractFeishuWithFallback({ url, manualSelector, sourceSettings, followTabs, sourceTabId }) {
  const credentials = await resolveFeishuCredentials(sourceSettings);

  if (credentials) {
    try {
      await appendLog('info', 'extract', '飞书提取：尝试 OpenAPI', { url });
      return await extractFeishuDocByApi({
        url,
        appId: credentials.appId,
        appSecret: credentials.appSecret
      });
    } catch (error) {
      if (isFeishuPermissionDeniedError(error)) {
        throw new Error('读取失败：请先在该飞书文档中添加应用（机器人）并授予文档访问权限，然后重试提取');
      }
      await appendLog('warn', 'extract', '飞书 OpenAPI 提取失败，切换页面兜底', {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  } else {
    await appendLog('warn', 'extract', '未配置飞书 App 凭据，使用页面兜底提取', { url });
  }

  const fallback = await extractByTabInjection(url, manualSelector, { followTabs, sourceTabId });

  if (credentials) {
    const hints = Array.isArray(fallback.validationHints) ? fallback.validationHints : [];
    hints.push('已回退到页面提取模式，建议检查飞书应用权限配置');
    fallback.validationHints = hints;
  }

  return fallback;
}

function isFeishuPermissionDeniedError(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  if (!message) {
    return false;
  }

  return /(forbidden|no permission|permission denied|权限|无权限|未授权|access denied|not authorized)/i.test(message) ||
    /(code=177003|code=91403|code=99991663|code=99991661)/i.test(message);
}

async function extractByTabInjection(url, manualSelector, { followTabs, sourceTabId }) {
  const tab = await chrome.tabs.create({ url, active: Boolean(followTabs) });
  const tabId = tab.id;

  if (!tabId) {
    throw new Error('无法创建用于提取的标签页');
  }

  try {
    if (followTabs) {
      await activateTab(tabId);
    }

    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    await delay(isFeishuDocUrl(url) ? 2200 : 1200);

    const extractorFunc = isFeishuDocUrl(url) ? extractFeishuDocInPage : extractWechatArticleInPage;

    const executionResult = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractorFunc,
      args: [manualSelector]
    });

    const payload = executionResult?.[0]?.result;
    if (!payload?.ok) {
      throw new Error(payload?.error || '页面提取脚本执行失败');
    }

    return payload.data;
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // 标签页可能被用户手动关闭
    }

    if (followTabs && sourceTabId) {
      await activateTab(sourceTabId);
    }
  }
}

function evaluateExtractionIntegrity(article) {
  const missing = [];
  const warnings = [];

  if (!article?.title?.trim()) {
    missing.push('标题');
  }

  if (!article?.contentHtml?.trim()) {
    missing.push('正文');
  }

  if (!article?.wordCount) {
    warnings.push('正文字数为 0，可能存在提取异常');
  }

  if (!article?.coverUrl && !article?.coverToken) {
    warnings.push('未识别到封面图，可手动上传封面');
  }

  if (Array.isArray(article?.images)) {
    const invalidImages = article.images.filter((image) => !image?.src && !image?.token);
    if (invalidImages.length > 0) {
      warnings.push(`有 ${invalidImages.length} 张图片链接不完整，建议手动补提`);
    }
  }

  if ((article?.paragraphCount ?? 0) < 1) {
    warnings.push('未检测到段落结构，可能为特殊版式文章');
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
    summary: {
      wordCount: article?.wordCount ?? 0,
      imageCount: article?.imageCount ?? 0,
      paragraphCount: article?.paragraphCount ?? 0
    }
  };
}

async function publishContent({
  platformIds = [],
  content = {},
  contentTransferId = '',
  followTabs = true,
  sourceTabId = null
}) {
  if (!Array.isArray(platformIds) || platformIds.length === 0) {
    throw new Error('请至少选择一个发布平台');
  }

  const uniquePlatformIds = [...new Set(platformIds)].filter((id) => Boolean(PLATFORMS[id]));
  if (uniquePlatformIds.length === 0) {
    throw new Error('未识别到可用平台');
  }

  const rawContent = contentTransferId ? consumeTransferredContent(contentTransferId) : content;
  const normalizedContent = normalizeContentPayload(rawContent);

  if (!normalizedContent.title) {
    throw new Error('发布前请填写文章标题');
  }

  if (!normalizedContent.contentHtml.trim() && !normalizedContent.textPlain.trim()) {
    throw new Error('发布前请确认正文内容不为空');
  }

  await appendLog('info', 'publish', '开始同步发布', {
    platformIds: uniquePlatformIds,
    title: normalizedContent.title
  });

  const results = [];
  const total = uniquePlatformIds.length;

  for (let index = 0; index < uniquePlatformIds.length; index += 1) {
    const platformId = uniquePlatformIds[index];
    const platform = PLATFORMS[platformId];

    try {
      broadcastProgress({
        phase: 'start',
        platformId,
        platformName: platform.name,
        current: index + 1,
        total,
        message: `开始处理 ${platform.name}`
      });

      const result = await publishWithRetry(platform, normalizedContent, index + 1, total, {
        followTabs,
        sourceTabId
      });
      const finalResult = {
        platformId,
        platformName: platform.name,
        status: 'success',
        tabId: result.tabId,
        attempts: result.attempts,
        warnings: result.warnings,
        detail: result.detail
      };

      results.push(finalResult);

      await appendLog('info', 'publish', `${platform.name} 自动填充完成`, {
        platformId,
        attempts: result.attempts,
        warnings: result.warnings
      });

      broadcastProgress({
        phase: 'success',
        platformId,
        platformName: platform.name,
        current: index + 1,
        total,
        message: `${platform.name} 已完成自动填充`,
        detail: result.detail
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallbackDraft = await saveFailedDraft(platformId, normalizedContent, message);
      const fallbackUrl = `${FALLBACK_PAGE_URL}?platform=${encodeURIComponent(platformId)}`;

      try {
        const fallbackTab = await chrome.tabs.create({ url: fallbackUrl, active: Boolean(followTabs) });
        if (followTabs && fallbackTab?.id) {
          await activateTab(fallbackTab.id);
        }
      } catch {
        // 回退页打开失败不影响主流程
      }

      const failResult = {
        platformId,
        platformName: platform.name,
        status: 'failed',
        error: message,
        fallbackDraftId: fallbackDraft.id,
        fallbackUrl
      };

      results.push(failResult);

      await appendLog('error', 'publish', `${platform.name} 发布失败，已生成回退草稿`, {
        platformId,
        error: message,
        fallbackDraftId: fallbackDraft.id
      });

      broadcastProgress({
        phase: 'failed',
        platformId,
        platformName: platform.name,
        current: index + 1,
        total,
        message: `${platform.name} 发布失败，已回退到草稿`,
        error: message
      });
    }
  }

  const summary = {
    total,
    success: results.filter((item) => item.status === 'success').length,
    failed: results.filter((item) => item.status === 'failed').length
  };

  await appendLog('info', 'publish', '同步发布流程结束', summary);

  broadcastProgress({
    phase: 'finish',
    current: total,
    total,
    message: `发布流程结束：成功 ${summary.success}，失败 ${summary.failed}`,
    summary
  });

  return { results, summary };
}

function normalizeContentPayload(content) {
  const title = typeof content?.title === 'string' ? content.title.trim() : '';
  const coverUrl = typeof content?.coverUrl === 'string' ? content.coverUrl.trim() : '';
  const contentHtml = typeof content?.contentHtml === 'string' ? content.contentHtml : '';
  const sourceUrl = typeof content?.sourceUrl === 'string' ? content.sourceUrl.trim() : '';
  const publishAction =
    content?.publishAction === 'publish'
      ? 'publish'
      : content?.publishAction === 'none'
      ? 'none'
      : 'draft';
  const preferImporter = content?.preferImporter !== false;

  let textPlain = typeof content?.textPlain === 'string' ? content.textPlain.trim() : '';
  if (!textPlain && contentHtml) {
    textPlain = stripHtml(contentHtml);
  }

  const images = Array.isArray(content?.images)
    ? content.images
        .map((item, index) => ({
          index,
          src: typeof item?.src === 'string' ? item.src : ''
        }))
        .filter((item) => item.src)
    : [];

  return {
    title,
    sourceUrl,
    coverUrl,
    contentHtml,
    textPlain,
    images,
    publishAction,
    preferImporter
  };
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function publishWithRetry(platform, content, current, total, options = {}) {
  let lastError;

  for (let attempt = 1; attempt <= PUBLISH_RETRY_LIMIT; attempt += 1) {
    try {
      broadcastProgress({
        phase: 'running',
        platformId: platform.id,
        platformName: platform.name,
        current,
        total,
        message: `${platform.name} 自动填充中（第 ${attempt} 次）`
      });

      const result = await publishOnPlatform(platform, content, options);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;

      if (attempt < PUBLISH_RETRY_LIMIT) {
        await appendLog('warn', 'publish', `${platform.name} 自动填充失败，准备重试`, {
          attempt,
          error: error instanceof Error ? error.message : String(error)
        });
        await delay(1200 * attempt);
      }
    }
  }

  throw lastError ?? new Error('发布失败');
}

async function publishOnPlatform(platform, content, options = {}) {
  const followTabs = Boolean(options.followTabs);
  const adapter = PLATFORM_ADAPTER_MAP[platform.id];
  const tab = await chrome.tabs.create({ url: platform.publishUrl, active: followTabs });
  const tabId = tab.id;

  if (!tabId) {
    throw new Error('发布页打开失败');
  }

  if (followTabs) {
    await activateTab(tabId);
  }

  await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
  await delay(1500);

  if (!adapter?.publishApi) {
    throw new Error(`平台适配器缺失：${platform.id}`);
  }

  const extractedPayload = adapter.extractor ? adapter.extractor(content) : { ...content };
  const processedPayload = adapter.contentProcessor
    ? adapter.contentProcessor(extractedPayload)
    : extractedPayload;
  const imageProcessedPayload = adapter.imageProcessor
    ? await adapter.imageProcessor(processedPayload)
    : processedPayload;

  const publishPayload = {
    ...imageProcessedPayload,
    platformId: platform.id,
    platformName: platform.name
  };

  const runtime = {
    withTimeout,
    autoFillFunc: autoFillPublishPage,
    executeInTab: ({ tabId: targetTabId, func, args = [], timeoutMs = 50_000 }) =>
      withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          world: 'ISOLATED',
          func,
          args
        }),
        timeoutMs,
        `${platform.name} 自动填充超时`
      )
  };

  const adapterResult = await adapter.publishApi({
    tabId,
    payload: publishPayload,
    runtime
  });

  if (!adapterResult?.ok && adapterResult?.code === 'LOGIN_REQUIRED' && platform.id === 'foodtalks') {
    await appendLog('info', 'publish', '检测到 FoodTalks 需要登录，等待用户登录完成', {
      platformId: platform.id,
      tabId
    });

    broadcastProgress({
      phase: 'running',
      platformId: platform.id,
      platformName: platform.name,
      current: 1,
      total: 1,
      message: '请在新标签页完成 FoodTalks 登录，登录后将自动继续填充...'
    });

    const loginCompleted = await waitForFoodtalksPostLogin(tabId, LOGIN_WAIT_TIMEOUT_MS);
    if (!loginCompleted) {
      throw new Error('FoodTalks 登录等待超时，请重新点击同步并在 3 分钟内完成登录');
    }

    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    await delay(1200);

    const retryResult = await adapter.publishApi({
      tabId,
      payload: publishPayload,
      runtime
    });

    if (!retryResult?.ok) {
      throw new Error(retryResult?.error || `${platform.name} 登录后自动填充失败`);
    }

    return {
      tabId,
      warnings: retryResult.warnings ?? [],
      detail: retryResult.detail ?? {}
    };
  }

  if (!adapterResult?.ok) {
    throw new Error(adapterResult?.error || `${platform.name} 自动填充失败`);
  }

  return {
    tabId,
    warnings: adapterResult.warnings ?? [],
    detail: adapterResult.detail ?? {}
  };
}

async function waitForFoodtalksPostLogin(tabId, timeoutMs = LOGIN_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(15_000, timeoutMs);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) {
      return false;
    }

    const url = String(tab.url || '');
    if (url.includes('admin-we.foodtalks.cn') && !url.includes('/#/login')) {
      return true;
    }

    await delay(900);
  }

  return false;
}

async function publishXiaohongshuBySteps(tabId, content, platformName) {
  const readyDeadline = Date.now() + 45_000;
  let lastProbe = null;

  while (Date.now() < readyDeadline) {
    const probeResult = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: probeXiaohongshuEditorStep
      }),
      12_000,
      `${platformName} 编辑器探测超时`
    );

    const probe = probeResult?.[0]?.result ?? {};
    lastProbe = probe;

    if (probe.loginRequired) {
      throw new Error('检测到当前平台未登录，请先登录后重试同步发布');
    }

    if (probe.ready) {
      break;
    }

    await delay(probe.clickedCreate ? 1400 : 800);
  }

  if (!lastProbe?.ready) {
    throw new Error(`${platformName} 编辑器初始化超时`);
  }

  const fillResult = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: fillXiaohongshuFieldsStep,
      args: [
        {
          title: content.title,
          contentHtml: content.contentHtml,
          textPlain: content.textPlain,
          coverUrl: content.coverUrl,
          imageCount: content.images?.length ?? 0
        }
      ]
    }),
    20_000,
    `${platformName} 内容填充超时`
  );

  const detail = fillResult?.[0]?.result;
  if (!detail?.ok) {
    throw new Error(detail?.error || `${platformName} 自动填充失败`);
  }

  return detail;
}

function probeXiaohongshuEditorStep() {
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const findFirstVisible = (selectors) => {
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      const hit = nodes.find((node) => isVisible(node));
      if (hit) {
        return hit;
      }
    }
    return null;
  };

  const clickLikeUser = (node) => {
    if (!node) {
      return false;
    }

    try {
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    } catch {
      // ignore pointer event failure
    }
    try {
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } catch {
      // ignore mousedown failure
    }
    try {
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    } catch {
      // ignore mouseup failure
    }

    try {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    } catch {
      try {
        node.click();
        return true;
      } catch {
        return false;
      }
    }
  };

  const href = location.href.toLowerCase();
  const loginRequired =
    href.includes('login') ||
    href.includes('signin') ||
    href.includes('passport') ||
    Boolean(document.querySelector('input[type="password"], .login, .signin, .passport, [class*="login"]'));

  const titleSelectors = [
    'textarea[placeholder*="输入标题"]',
    'textarea[placeholder*="标题"]',
    'input[placeholder*="标题"]',
    '[class*="title"] textarea',
    '[class*="title"] input'
  ];
  const editorSelectors = [
    '.tiptap.ProseMirror[contenteditable="true"]',
    '.tiptap.ProseMirror',
    '.ProseMirror[contenteditable="true"]',
    '.ProseMirror',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]'
  ];

  const titleNode = findFirstVisible(titleSelectors);
  const editorNode = findFirstVisible(editorSelectors);
  const ready = Boolean(titleNode && editorNode);

  let clickedCreate = false;
  if (!ready && !loginRequired) {
    const clickableNodes = [
      ...document.querySelectorAll('button, [role="button"], .d-button, .custom-button')
    ].filter((node) => isVisible(node));

    const createButton =
      clickableNodes.find((node) => {
        const text = (node.textContent || '').replace(/\s+/g, '');
        return text.includes('新的创作') || text.includes('开始创作') || text.includes('去创作');
      }) ||
      clickableNodes.find((node) => {
        const className = (node.className || '').toString().toLowerCase();
        return className.includes('new-btn') || className.includes('create') || className.includes('new');
      });

    if (createButton) {
      clickedCreate = clickLikeUser(createButton);
    }
  }

  return {
    ready,
    clickedCreate,
    loginRequired,
    finalUrl: location.href
  };
}

async function fillXiaohongshuFieldsStep(payload) {
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const findFirstVisible = (selectors) => {
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      const hit = nodes.find((node) => isVisible(node));
      if (hit) {
        return hit;
      }
    }
    return null;
  };

  const setNativeValue = (input, value) => {
    if (!input) {
      return false;
    }

    try {
      input.focus();
      const descriptor = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value');
      if (descriptor?.set) {
        descriptor.set.call(input, value);
      } else {
        input.value = value;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const blobToDataUri = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('file read failed'));
      reader.readAsDataURL(blob);
    });

  const convertImagesToDataUri = async (html, maxCount = 8) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html || '';

    const images = [...wrapper.querySelectorAll('img[src]')].slice(0, maxCount);
    for (const img of images) {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) {
        continue;
      }

      try {
        const response = await fetch(src, { credentials: 'omit' });
        if (!response.ok) {
          continue;
        }
        const blob = await response.blob();
        if (!blob || blob.size <= 0 || blob.size > 8 * 1024 * 1024) {
          continue;
        }
        const dataUri = await blobToDataUri(blob);
        if (typeof dataUri === 'string' && dataUri.startsWith('data:image/')) {
          img.setAttribute('src', dataUri);
        }
      } catch {
        // keep original src on failure
      }
    }

    return wrapper.innerHTML;
  };

  const setEditorContent = (editor, html, text) => {
    if (!editor) {
      return false;
    }

    const normalizedText = (text || '').trim();
    const normalizedHtml = (html || '').trim();
    if (!normalizedText && !normalizedHtml) {
      return false;
    }

    try {
      editor.focus();
      editor.innerHTML = normalizedHtml || normalizedText;

      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch {
      try {
        editor.textContent = normalizedText;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch {
        return false;
      }
    }
  };

  const titleNode = findFirstVisible([
    'textarea[placeholder*="输入标题"]',
    'textarea[placeholder*="标题"]',
    'input[placeholder*="标题"]',
    '[class*="title"] textarea',
    '[class*="title"] input'
  ]);
  const editorNode = findFirstVisible([
    '.tiptap.ProseMirror[contenteditable="true"]',
    '.tiptap.ProseMirror',
    '.ProseMirror[contenteditable="true"]',
    '.ProseMirror',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]'
  ]);

  const sanitizedWrapper = document.createElement('div');
  sanitizedWrapper.innerHTML = payload.contentHtml || '';
  sanitizedWrapper.querySelectorAll('script,style,iframe,link,meta').forEach((node) => node.remove());
  const safeHtml = await convertImagesToDataUri(sanitizedWrapper.innerHTML, 8);

  const titleOk = titleNode ? setNativeValue(titleNode, payload.title || '') : false;
  const contentOk = editorNode ? setEditorContent(editorNode, safeHtml, payload.textPlain || '') : false;

  const warnings = [];
  if (!titleOk) {
    warnings.push('小红书标题控件未匹配');
  }
  if (!contentOk) {
    warnings.push('小红书正文编辑器未匹配');
  }
  if (!payload.coverUrl) {
    warnings.push('当前内容未包含封面图');
  }

  return {
    ok: titleOk && contentOk,
    titleOk,
    contentOk,
    coverOk: false,
    warnings,
    debug: {
      finalUrl: location.href,
      titleSelectorMatched: Boolean(titleNode),
      editorSelectorMatched: Boolean(editorNode)
    }
  };
}

async function autoFillPublishPage(payload) {
  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const profileMap = {
    xiaohongshu: {
      title: [
        'textarea[placeholder*="输入标题"]',
        'textarea[placeholder*="标题"]',
        'input[placeholder*="标题"]',
        '[contenteditable="true"][data-placeholder*="标题"]',
        '[class*="title"] [contenteditable="true"]',
        '[class*="title"] textarea'
      ],
      editor: [
        '.tiptap.ProseMirror',
        '[contenteditable="true"][data-placeholder*="正文"]',
        '[class*="editor"] [contenteditable="true"]',
        '[class*="note"] [contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        '.ql-editor',
        '.ProseMirror'
      ],
      cover: ['input[placeholder*="封面"]', 'input[placeholder*="图片"]', 'input[type="url"]'],
      preferPlainText: false,
      stripImages: false
    },
    zhihu: {
      title: [
        'h1[contenteditable="true"]',
        '.Post-Title h1[contenteditable="true"]',
        '.TitleInput-input',
        'input[placeholder*="标题"]'
      ],
      editor: [
        '.RichText.ztext[contenteditable="true"]',
        '.RichText[contenteditable="true"]',
        '[data-lexical-editor="true"]',
        '.DraftEditor-root div[contenteditable="true"]',
        '.Editable-content'
      ],
      cover: ['input[placeholder*="封面"]', 'input[placeholder*="图片"]', 'input[type="url"]'],
      preferPlainText: false,
      stripImages: false
    },
    toutiao: {
      title: ['input[placeholder*="标题"]', 'input[placeholder*="请输入文章标题"]', '.title-input input'],
      editor: ['.ql-editor', '.ProseMirror', '.byted-editor-content', 'div[contenteditable="true"]'],
      cover: ['input[placeholder*="封面"]', 'input[placeholder*="图片"]', 'input[type="url"]'],
      preferPlainText: false,
      stripImages: false
    },
    baijiahao: {
      title: ['input[placeholder*="标题"]', 'input[placeholder*="请输入标题"]', '.article-title input'],
      editor: ['.ql-editor', '.ProseMirror', '.editor-content [contenteditable="true"]', 'div[contenteditable="true"]'],
      cover: ['input[placeholder*="封面"]', 'input[placeholder*="图片"]', 'input[type="url"]'],
      preferPlainText: false,
      stripImages: false
    },
    bilibili: {
      title: ['input[placeholder*="标题"]', 'input[placeholder*="请输入标题"]', '.article-title input'],
      editor: ['.ql-editor', '.ProseMirror', '.article-content [contenteditable="true"]', 'div[contenteditable="true"]'],
      cover: ['input[placeholder*="封面"]', 'input[placeholder*="图片"]', 'input[type="url"]'],
      preferPlainText: false,
      stripImages: false
    }
  };

  const genericSelectors = {
    title: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', 'h1[contenteditable="true"]'],
    editor: ['.ql-editor', '.ProseMirror', '.RichText[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    cover: ['input[placeholder*="封面"]', 'input[placeholder*="图片"]', 'input[type="url"]']
  };

  const uniqueSelectors = (selectors) => [...new Set((selectors || []).filter(Boolean))];

  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const collectNodes = (selectors) => {
    const unique = new Set();
    const result = [];

    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      for (const node of nodes) {
        if (!unique.has(node)) {
          unique.add(node);
          result.push(node);
        }
      }
    }

    return result.filter((node) => isVisible(node));
  };

  const scoreNode = (node, mode = 'generic', titleBottom = 0) => {
    const rect = node.getBoundingClientRect();
    const area = rect.width * rect.height;
    const placeholder = (node.getAttribute('placeholder') || node.getAttribute('data-placeholder') || '').toLowerCase();
    const className = (node.className || '').toString().toLowerCase();
    const tag = node.tagName.toLowerCase();

    let score = area;

    if (mode === 'title') {
      if (placeholder.includes('标题')) {
        score += 400_000;
      }
      if (className.includes('title')) {
        score += 200_000;
      }
      if (tag === 'h1') {
        score += 300_000;
      }
      if (rect.top < 420) {
        score += 120_000;
      }
      if (rect.height > 150) {
        score -= 150_000;
      }
    }

    if (mode === 'editor') {
      if (placeholder.includes('正文') || placeholder.includes('内容')) {
        score += 260_000;
      }
      if (className.includes('editor') || className.includes('content') || className.includes('rich')) {
        score += 160_000;
      }
      if (rect.top >= titleBottom) {
        score += 120_000;
      }
      if (rect.height >= 180) {
        score += 200_000;
      }
      if (rect.width < 360 || rect.height < 60) {
        score -= 280_000;
      }
    }

    return score;
  };

  const pickBestNode = (selectors, mode = 'generic', titleBottom = 0) => {
    const nodes = collectNodes(selectors);
    if (nodes.length === 0) {
      return null;
    }

    const ranked = nodes
      .map((node) => ({ node, score: scoreNode(node, mode, titleBottom) }))
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.node ?? null;
  };

  const waitForNode = async (selectors, mode = 'generic', timeoutMs = 12_000, titleBottom = 0) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const node = pickBestNode(selectors, mode, titleBottom);
      if (node) {
        return node;
      }
      await sleep(260);
    }

    return null;
  };

  const waitForSelector = async (selectors, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node && isVisible(node)) {
          return node;
        }
      }
      await sleep(240);
    }
    return null;
  };

  const setNativeValue = (input, value) => {
    if (!input) {
      return false;
    }

    try {
      input.focus();
      const descriptor = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value');
      if (descriptor?.set) {
        descriptor.set.call(input, value);
      } else {
        input.value = value;
      }

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const clearEditable = (node) => {
    try {
      node.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand('delete', false);
    } catch {
      node.innerHTML = '';
      node.textContent = '';
    }
  };

  const escapeHtml = (text) =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const toPlainText = (html) => {
    const container = document.createElement('div');
    container.innerHTML = html || '';

    const lines = [];
    container.querySelectorAll('h1,h2,h3,h4,p,li,blockquote').forEach((node) => {
      const text = node.textContent?.trim();
      if (text) {
        lines.push(text);
      }
    });

    if (lines.length === 0) {
      const fallbackText = container.textContent?.trim();
      if (fallbackText) {
        lines.push(fallbackText);
      }
    }

    return lines.join('\n\n').trim();
  };

  const sanitizeHtmlForEditor = (html, options = {}) => {
    const { stripImages = false } = options;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html || '';

    wrapper.querySelectorAll('script,style,iframe,link,meta').forEach((node) => node.remove());
    if (stripImages) {
      wrapper.querySelectorAll('img').forEach((node) => node.remove());
    }

    wrapper.querySelectorAll('*').forEach((node) => {
      node.removeAttribute('id');
      node.removeAttribute('data-id');
      node.removeAttribute('onload');
      node.removeAttribute('onclick');
      if (node.tagName === 'IMG') {
        node.style.maxWidth = '100%';
        node.style.height = 'auto';
      }
    });

    return wrapper.innerHTML;
  };

  const mapWithConcurrency = async (items, worker, concurrency = 3) => {
    const results = new Array(items.length);
    let cursor = 0;

    const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        try {
          results[index] = await worker(items[index], index);
        } catch {
          results[index] = null;
        }
      }
    });

    await Promise.all(runners);
    return results;
  };

  const uploadZhihuImageByUrl = async (src) => {
    const body = new URLSearchParams({
      url: src,
      source: 'article'
    });
    const response = await fetch('https://zhuanlan.zhihu.com/api/uploaded_images', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'fetch'
      },
      body
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json().catch(() => ({}));
    const uploadedUrl = payload?.src;
    return typeof uploadedUrl === 'string' && uploadedUrl ? uploadedUrl : null;
  };

  const preprocessZhihuHtml = async (html) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html || '';

    const images = [...wrapper.querySelectorAll('img[src]')];
    const srcList = [...new Set(images.map((img) => img.getAttribute('src')).filter(Boolean))];
    const externalList = srcList.filter((src) => !/zhimg\.com/i.test(src));

    if (externalList.length > 0) {
      const uploadedUrls = await mapWithConcurrency(
        externalList.slice(0, 24),
        async (src) => ({ src, uploaded: await uploadZhihuImageByUrl(src) }),
        3
      );
      const replaceMap = new Map(
        (uploadedUrls || [])
          .filter((item) => item?.src && item?.uploaded)
          .map((item) => [item.src, item.uploaded])
      );

      images.forEach((img) => {
        const src = img.getAttribute('src') || '';
        if (!src) {
          return;
        }
        const uploaded = replaceMap.get(src);
        if (uploaded) {
          img.setAttribute('src', uploaded);
        }
      });
    }

    wrapper.querySelectorAll('img').forEach((img) => {
      const parentTag = img.parentElement?.tagName?.toLowerCase();
      if (parentTag !== 'figure') {
        const figure = document.createElement('figure');
        img.replaceWith(figure);
        figure.appendChild(img);
      }
    });

    return wrapper.innerHTML;
  };

  const htmlFromPlainText = (text) =>
    (text || '')
      .split(/\n{2,}/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('');

  const setRichEditorContent = (editor, html, text, preferPlainText) => {
    if (!editor) {
      return false;
    }

    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      return setNativeValue(editor, text || '');
    }

    try {
      editor.focus();
      clearEditable(editor);

      const targetText = text || '';
      const targetHtml = html || htmlFromPlainText(targetText);
      let inserted = false;

      if (preferPlainText) {
        inserted = document.execCommand('insertText', false, targetText);
      } else {
        inserted = document.execCommand('insertHTML', false, targetHtml);
      }

      if (!inserted) {
        if (preferPlainText) {
          editor.textContent = targetText;
        } else {
          editor.innerHTML = targetHtml;
        }
      }

      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch {
      try {
        editor.textContent = text || '';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch {
        return false;
      }
    }
  };

  const setTitleContent = (titleNode, text) => {
    if (!titleNode) {
      return false;
    }

    if (titleNode instanceof HTMLInputElement || titleNode instanceof HTMLTextAreaElement) {
      return setNativeValue(titleNode, text || '');
    }

    return setRichEditorContent(titleNode, '', text || '', true);
  };

  const hasLoginChallenge = () => {
    const href = location.href.toLowerCase();
    if (href.includes('login') || href.includes('signin') || href.includes('passport')) {
      return true;
    }

    return Boolean(document.querySelector('input[type="password"], .login, .signin, .passport, [class*="login"]'));
  };

  const fillXiaohongshuQuick = async ({ title, contentHtml, textPlain, images, coverUrl, timeoutMs }) => {
    const xiaohongshuTitleSelectors = [
      'textarea[placeholder*="输入标题"]',
      'textarea[placeholder*="标题"]',
      'input[placeholder*="标题"]',
      '[class*="title"] textarea',
      '[class*="title"] input'
    ];
    const xiaohongshuEditorSelectors = [
      '.tiptap.ProseMirror[contenteditable="true"]',
      '.tiptap.ProseMirror',
      '.ProseMirror[contenteditable="true"]',
      '.ProseMirror',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"]'
    ];

    const clickLikeUser = (node) => {
      if (!node) {
        return;
      }

      try {
        node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      } catch {
        // ignore pointerdown failure
      }
      try {
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      } catch {
        // ignore mousedown failure
      }
      try {
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      } catch {
        // ignore mouseup failure
      }
      try {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      } catch {
        try {
          node.click();
        } catch {
          // ignore final click failure
        }
      }
    };

    const hasXiaohongshuEditor = () => {
      const titleNode = pickBestNode(xiaohongshuTitleSelectors, 'title');
      const editorNode = pickBestNode(xiaohongshuEditorSelectors, 'editor');
      return Boolean(titleNode && editorNode);
    };

    const findXiaohongshuCreateButton = () => {
      const clickableNodes = [
        ...document.querySelectorAll('button, [role="button"], .d-button, .custom-button')
      ].filter((node) => isVisible(node));

      const byText = clickableNodes.find((node) => {
        const text = (node.textContent || '').replace(/\s+/g, '');
        return text.includes('新的创作') || text.includes('开始创作') || text.includes('去创作');
      });
      if (byText) {
        return byText;
      }

      return clickableNodes.find((node) => {
        const className = (node.className || '').toString().toLowerCase();
        return className.includes('new-btn') || className.includes('new') || className.includes('create');
      });
    };

    const ensureXiaohongshuEditorReady = async () => {
      if (hasXiaohongshuEditor()) {
        return true;
      }

      const deadline = Date.now() + timeoutMs;
      let clicked = false;

      while (Date.now() < deadline) {
        if (!clicked) {
          const createButton = findXiaohongshuCreateButton();
          if (createButton) {
            clickLikeUser(createButton);
            clicked = true;
            await sleep(1_200);
          }
        }

        if (hasXiaohongshuEditor()) {
          return true;
        }
        await sleep(260);
      }

      return hasXiaohongshuEditor();
    };

    const editorReady = await ensureXiaohongshuEditorReady();

    const titleNode = await waitForSelector(xiaohongshuTitleSelectors, timeoutMs);
    const editorNode = await waitForSelector(xiaohongshuEditorSelectors, timeoutMs);

    const cleanedHtml = sanitizeHtmlForEditor(contentHtml || '', { stripImages: false });
    const plainText = textPlain || toPlainText(cleanedHtml);
    const finalText = plainText || toPlainText(cleanedHtml);

    const titleOk = titleNode ? setTitleContent(titleNode, title || '') : false;
    const contentOk = editorNode ? setRichEditorContent(editorNode, '', finalText, true) : false;

    let coverOk = false;
    const warnings = [];
    if (coverUrl) {
      const coverNode = await waitForSelector(
        ['input[placeholder*="封面"]', 'input[placeholder*="图片"]', 'input[type="url"]'],
        2_000
      );
      coverOk = coverNode ? setNativeValue(coverNode, coverUrl) : false;
      if (!coverOk) {
        warnings.push('未找到可自动填充的封面控件，封面链接已保留用于手动上传');
      }
    } else {
      warnings.push('当前内容未包含封面图');
    }

    if (!editorReady) {
      warnings.push('未进入小红书创作编辑页，请先点击“新的创作”后重试');
    }
    if (!titleOk) {
      warnings.push('小红书标题控件未匹配');
    }
    if (!contentOk) {
      warnings.push('小红书正文编辑器未匹配');
    }
    return {
      ok: titleOk && contentOk,
      titleOk,
      contentOk,
      coverOk,
      warnings,
      debug: {
        titleSelectorMatched: Boolean(titleNode),
        editorSelectorMatched: Boolean(editorNode),
        finalUrl: location.href
      }
    };
  };

  try {
    const profile = profileMap[payload.platformId];
    if (!profile) {
      return { ok: false, error: '平台适配器不存在' };
    }

    if (hasLoginChallenge()) {
      return { ok: false, error: '检测到当前平台未登录，请先登录后重试同步发布' };
    }

    const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : 16_000;

    if (payload.platformId === 'xiaohongshu') {
      return await fillXiaohongshuQuick({
        title: payload.title || '',
        contentHtml: payload.contentHtml || '',
        textPlain: payload.textPlain || '',
        images: payload.images || [],
        coverUrl: payload.coverUrl || '',
        timeoutMs
      });
    }

    let cleanedHtml = sanitizeHtmlForEditor(payload.contentHtml || '', { stripImages: profile.stripImages });
    if (payload.platformId === 'zhihu') {
      cleanedHtml = await preprocessZhihuHtml(cleanedHtml);
    }
    const plainText = payload.textPlain || toPlainText(cleanedHtml);
    const finalText = profile.preferPlainText ? toPlainText(cleanedHtml) : plainText;

    const titleSelectors = uniqueSelectors([...profile.title, ...genericSelectors.title]);
    const editorSelectors = uniqueSelectors([...profile.editor, ...genericSelectors.editor]);
    const coverSelectors = uniqueSelectors([...profile.cover, ...genericSelectors.cover]);

    const titleNode = await waitForNode(titleSelectors, 'title', timeoutMs, 0);
    const titleRect = titleNode?.getBoundingClientRect();
    const editorNode = await waitForNode(editorSelectors, 'editor', timeoutMs, titleRect?.bottom || 0);

    const titleOk = titleNode ? setTitleContent(titleNode, payload.title || '') : false;

    let contentOk = false;
    if (editorNode) {
      contentOk = setRichEditorContent(editorNode, cleanedHtml, finalText, profile.preferPlainText);
      if (!contentOk) {
        await sleep(300);
        contentOk = setRichEditorContent(editorNode, cleanedHtml, finalText, profile.preferPlainText);
      }
    }

    let coverOk = false;
    const warnings = [];

    if (payload.coverUrl) {
      const coverNode = pickBestNode(coverSelectors, 'generic') || (await waitForNode(coverSelectors, 'generic', 4_000));
      coverOk = coverNode ? setNativeValue(coverNode, payload.coverUrl) : false;
      if (!coverOk) {
        warnings.push('未找到可自动填充的封面控件，封面链接已保留用于手动上传');
      }
    } else {
      warnings.push('当前内容未包含封面图');
    }

    if (!titleOk) {
      warnings.push('未找到标题输入框，请手动确认');
    }

    if (!contentOk) {
      warnings.push('未找到正文编辑器，请手动粘贴');
    }

    if ((payload.images?.length ?? 0) > 0 && profile.stripImages) {
      warnings.push('该平台暂不自动搬运微信图片，请在平台编辑器内手动上传图片');
    }

    return {
      ok: titleOk && contentOk,
      titleOk,
      contentOk,
      coverOk,
      warnings,
      debug: {
        titleSelectorMatched: Boolean(titleNode),
        editorSelectorMatched: Boolean(editorNode),
        finalUrl: location.href
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function saveFailedDraft(platformId, content, errorMessage) {
  const drafts = await readFailedDrafts();

  const draft = {
    id: crypto.randomUUID(),
    platformId,
    title: content.title,
    coverUrl: content.coverUrl,
    contentHtml: content.contentHtml,
    textPlain: content.textPlain,
    images: content.images,
    errorMessage,
    createdAt: new Date().toISOString()
  };

  const merged = [draft, ...drafts].slice(0, MAX_FAILED_DRAFTS);
  await chrome.storage.local.set({ [FAILED_DRAFT_KEY]: merged });

  return draft;
}

async function readFailedDrafts() {
  const store = await chrome.storage.local.get(FAILED_DRAFT_KEY);
  const drafts = Array.isArray(store?.[FAILED_DRAFT_KEY]) ? store[FAILED_DRAFT_KEY] : [];

  return drafts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function broadcastProgress(payload) {
  try {
    chrome.runtime.sendMessage({ type: 'PUBLISH_PROGRESS', payload }).catch(() => undefined);
  } catch {
    // 无监听方时忽略
  }
}

async function activateTab(tabId) {
  if (!tabId) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // 标签页不存在或窗口无法聚焦时忽略
  }
}

async function appendLog(level, stage, message, detail = {}) {
  const entry = {
    id: crypto.randomUUID(),
    level,
    stage,
    message,
    detail,
    createdAt: new Date().toISOString()
  };

  const logs = await readLogs();
  const merged = [entry, ...logs].slice(0, MAX_LOG_ITEMS);
  await chrome.storage.local.set({ [LOG_KEY]: merged });

  try {
    chrome.runtime.sendMessage({ type: 'LOG_UPDATE', payload: entry }).catch(() => undefined);
  } catch {
    // no-op
  }

  return entry;
}

async function readLogs() {
  const store = await chrome.storage.local.get(LOG_KEY);
  const logs = Array.isArray(store?.[LOG_KEY]) ? store[LOG_KEY] : [];

  return logs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timeoutId;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) {
        return;
      }

      if (changeInfo.status === 'complete') {
        settled = true;
        cleanup();
        resolve();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error('标签页已关闭')); 
    };

    timeoutId = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new Error('页面加载超时')); 
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.get(tabId).then((tab) => {
      if (settled) {
        return;
      }

      if (tab?.status === 'complete') {
        settled = true;
        cleanup();
        resolve();
      }
    }).catch(() => undefined);
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

function isWechatArticleUrl(url) {
  return /^https?:\/\/mp\.weixin\.qq\.com\//i.test(url);
}

function isSupportedSourceUrl(url) {
  return isWechatArticleUrl(url) || isFeishuDocUrl(url);
}

function normalizeSourceSettingsPayload(payload = {}) {
  const feishuAppId = typeof payload?.feishuAppId === 'string' ? payload.feishuAppId.trim() : '';
  const feishuAppSecret =
    typeof payload?.feishuAppSecret === 'string' ? payload.feishuAppSecret.trim() : '';

  return {
    feishuAppId: feishuAppId || DEFAULT_FEISHU_APP_ID,
    feishuAppSecret: feishuAppSecret || DEFAULT_FEISHU_APP_SECRET
  };
}

async function getSourceSettings() {
  const store = await chrome.storage.local.get(SOURCE_SETTINGS_KEY);
  return normalizeSourceSettingsPayload(store?.[SOURCE_SETTINGS_KEY] || {});
}

async function saveSourceSettings(payload = {}) {
  const normalized = normalizeSourceSettingsPayload(payload);
  await chrome.storage.local.set({
    [SOURCE_SETTINGS_KEY]: normalized
  });
  await appendLog('info', 'extract', '飞书凭据已更新', {
    hasAppId: Boolean(normalized.feishuAppId),
    hasAppSecret: Boolean(normalized.feishuAppSecret)
  });
  return normalized;
}

async function resolveFeishuCredentials(overrideSettings = null) {
  const merged = normalizeSourceSettingsPayload({
    ...(await getSourceSettings()),
    ...(overrideSettings || {})
  });

  if (!merged.feishuAppId || !merged.feishuAppSecret) {
    return null;
  }

  return {
    appId: merged.feishuAppId,
    appSecret: merged.feishuAppSecret
  };
}

async function fetchFeishuImageDataUrl({ mediaToken, sourceSettings = null }) {
  const token = typeof mediaToken === 'string' ? mediaToken.trim() : '';
  if (!token) {
    throw new Error('缺少飞书图片 token');
  }

  const cached = feishuImageDataUrlCache.get(token);
  if (cached?.dataUrl) {
    return { dataUrl: cached.dataUrl, mimeType: cached.mimeType || '' };
  }

  const credentials = await resolveFeishuCredentials(sourceSettings);
  if (!credentials) {
    throw new Error('缺少飞书 App 凭据，请先在插件页面保存 App ID 与 App Secret');
  }

  let imageData = null;
  let lastError = null;
  const maxAttempts = FEISHU_IMAGE_FETCH_RETRY_LIMIT;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      imageData = await downloadFeishuImageAsDataUrl({
        mediaToken: token,
        appId: credentials.appId,
        appSecret: credentials.appSecret
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || isNonRetryableFeishuImageError(error)) {
        break;
      }
      await delay(FEISHU_IMAGE_FETCH_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  if (!imageData) {
    throw lastError instanceof Error ? lastError : new Error('飞书图片下载失败');
  }

  feishuImageDataUrlCache.set(token, imageData);

  if (feishuImageDataUrlCache.size > MAX_FEISHU_IMAGE_CACHE_ITEMS) {
    const oldestKey = feishuImageDataUrlCache.keys().next().value;
    if (oldestKey) {
      feishuImageDataUrlCache.delete(oldestKey);
    }
  }

  return imageData;
}

function isNonRetryableFeishuImageError(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  if (!message) {
    return false;
  }

  return /(缺少飞书 app 凭据|缺少飞书图片 token|permission|forbidden|unauthorized|无权限|未授权|401|403|177003|91403|99991663)/i.test(
    message
  );
}

async function cacheKey(url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getCachedExtraction(url) {
  const key = await cacheKey(url);
  const store = await chrome.storage.local.get(CACHE_KEY);
  const cache = store?.[CACHE_KEY] ?? {};
  const item = cache[key];

  if (!item) {
    return null;
  }

  if (Date.now() - item.cachedAt > CACHE_TTL_MS) {
    delete cache[key];
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
    return null;
  }

  return item.data;
}

async function setCachedExtraction(url, data) {
  const key = await cacheKey(url);
  const store = await chrome.storage.local.get(CACHE_KEY);
  const cache = store?.[CACHE_KEY] ?? {};

  cache[key] = {
    cachedAt: Date.now(),
    data
  };

  const sortedEntries = Object.entries(cache)
    .sort((a, b) => (b[1]?.cachedAt ?? 0) - (a[1]?.cachedAt ?? 0))
    .slice(0, MAX_CACHE_ITEMS);

  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(sortedEntries) });
}

async function extractWechatArticleInPage(manualSelector) {
  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const normalizeUrl = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') {
      return '';
    }

    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return '';
    }

    if (trimmed.startsWith('data:')) {
      return '';
    }

    if (trimmed.startsWith('//')) {
      return `${location.protocol}${trimmed}`;
    }

    try {
      return new URL(trimmed, location.href).toString();
    } catch {
      return trimmed;
    }
  };

  const toOriginalImage = (rawUrl) => {
    if (!rawUrl) {
      return '';
    }

    let finalUrl = rawUrl;
    finalUrl = finalUrl.replace(/\/(640|320|300|200)(?=[/?#]|$)/g, '/0');
    finalUrl = finalUrl.replace(/[?&]tp=webp/gi, '');
    finalUrl = finalUrl.replace(/&&+/g, '&').replace(/[?&]$/, '');
    return finalUrl;
  };

  const firstNonEmpty = (values) => {
    for (const value of values) {
      if (!value) {
        continue;
      }

      const text = String(value).replace(/\s+/g, ' ').trim();
      if (text) {
        return text;
      }
    }

    return '';
  };

  const waitForLazyImages = async () => {
    const images = [...document.querySelectorAll('img')];

    images.forEach((img) => {
      const source =
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-url') ||
        img.getAttribute('data-lazy-src') ||
        img.getAttribute('src') ||
        '';

      const normalized = toOriginalImage(normalizeUrl(source));
      if (normalized && img.getAttribute('src') !== normalized) {
        img.setAttribute('src', normalized);
      }

      img.removeAttribute('srcset');
      img.loading = 'eager';
    });

    const viewport = Math.max(window.innerHeight, 480);
    const maxSteps = Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) / viewport) + 2;

    for (let step = 0; step < maxSteps; step += 1) {
      window.scrollTo(0, step * viewport);
      await sleep(130);
    }

    window.scrollTo(0, 0);

    await Promise.all(
      images.map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete && img.naturalWidth > 0) {
              resolve();
              return;
            }

            const done = () => {
              img.removeEventListener('load', done);
              img.removeEventListener('error', done);
              resolve();
            };

            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            setTimeout(done, 2600);
          })
      )
    );
  };

  const findContentRoot = () => {
    if (manualSelector) {
      const manualNode = document.querySelector(manualSelector);
      if (manualNode) {
        return manualNode;
      }
    }

    const candidates = [
      '#js_content',
      '#img-content',
      '.rich_media_content',
      '.rich_media_area_primary_inner',
      '.rich_media_wrp',
      'article',
      'main'
    ];

    for (const selector of candidates) {
      const node = document.querySelector(selector);
      if (node && node.textContent && node.textContent.replace(/\s+/g, '').length > 50) {
        return node;
      }
    }

    const blockCandidates = [...document.querySelectorAll('section, article, div')]
      .filter((node) => node.querySelectorAll('p').length >= 3)
      .map((node) => ({
        node,
        score: node.textContent?.replace(/\s+/g, '').length ?? 0
      }))
      .sort((a, b) => b.score - a.score);

    return blockCandidates[0]?.node ?? null;
  };

  try {
    await waitForLazyImages();

    const contentRoot = findContentRoot();
    if (!contentRoot) {
      throw new Error('未定位到正文内容区域，请输入手动选择器重试');
    }

    const title = firstNonEmpty([
      document.querySelector('#activity-name')?.textContent,
      document.querySelector('h1.rich_media_title')?.textContent,
      document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      document.querySelector('meta[name="twitter:title"]')?.getAttribute('content'),
      document.title
    ]);

    const cloned = contentRoot.cloneNode(true);
    cloned.querySelectorAll('script, style, noscript, iframe').forEach((node) => node.remove());

    const images = [];

    [...cloned.querySelectorAll('img')].forEach((img, index) => {
      const originalSrc =
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-url') ||
        img.getAttribute('src') ||
        '';

      const src = toOriginalImage(normalizeUrl(originalSrc));
      const alt = firstNonEmpty([img.getAttribute('alt'), img.getAttribute('data-alt')]);

      if (src) {
        img.setAttribute('src', src);
        img.removeAttribute('srcset');
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
      }

      images.push({
        index,
        src,
        alt
      });
    });

    [...cloned.querySelectorAll('a')].forEach((anchor) => {
      const href = anchor.getAttribute('href');
      if (href) {
        anchor.setAttribute('href', normalizeUrl(href));
      }
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    });

    const contentHtml = cloned.innerHTML.trim();
    const textPlain = (cloned.textContent || '').replace(/[\t\r\f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    const coverUrl = toOriginalImage(
      normalizeUrl(
        firstNonEmpty([
          document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
          document.querySelector('meta[name="twitter:image"]')?.getAttribute('content'),
          document.querySelector('#js_cover img')?.getAttribute('src'),
          images.find((item) => item.src)?.src
        ])
      )
    );

    const wordCount = textPlain.replace(/\s+/g, '').length;
    const paragraphCount = cloned.querySelectorAll('p, h1, h2, h3, li, blockquote').length;

    const warnings = [];
    if (!coverUrl) {
      warnings.push('未识别到封面图');
    }

    if (wordCount === 0) {
      warnings.push('正文字数为 0，可能提取失败');
    }

    return {
      ok: true,
      data: {
        sourceUrl: location.href,
        title,
        coverUrl,
        contentHtml,
        textPlain,
        wordCount,
        paragraphCount,
        imageCount: images.length,
        images,
        validationHints: warnings
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function extractFeishuDocInPage(manualSelector) {
  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const normalizeUrl = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') {
      return '';
    }

    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return '';
    }

    if (trimmed.startsWith('//')) {
      return `${location.protocol}${trimmed}`;
    }

    if (trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
      return '';
    }

    try {
      return new URL(trimmed, location.href).toString();
    } catch {
      return trimmed;
    }
  };

  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  const firstNonEmpty = (values) => {
    for (const value of values) {
      const text = normalizeText(value);
      if (text) {
        return text;
      }
    }
    return '';
  };

  const textLength = (node) => normalizeText(node?.textContent).replace(/\s+/g, '').length;

  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const isLoginPage = () => {
    const host = location.host.toLowerCase();
    if (host.includes('accounts.feishu.cn')) {
      return true;
    }

    const bodyText = (document.body?.innerText || '').slice(0, 1200);
    const title = document.title || '';
    return /(扫码登录|飛書 - 登入|飞书 - 登录|切换至Lark登录)/i.test(`${title}\n${bodyText}`);
  };

  const findContentRoot = () => {
    if (manualSelector) {
      const manualNode = document.querySelector(manualSelector);
      if (manualNode && textLength(manualNode) > 30) {
        return manualNode;
      }
    }

    const preferredSelectors = [
      '[data-testid*="doc"] [contenteditable="true"]',
      '[class*="docx"] [contenteditable="true"]',
      '[class*="lark-editor"] [contenteditable="true"]',
      '[class*="editor"] [contenteditable="true"]',
      '[data-testid*="editor"]',
      '[class*="docx-editor"]',
      '[class*="lark-editor"]',
      'main',
      'article'
    ];

    for (const selector of preferredSelectors) {
      const nodes = [...document.querySelectorAll(selector)].filter((node) => isVisible(node));
      const hit = nodes.find((node) => textLength(node) > 120);
      if (hit) return hit;
    }

    const badClassPattern = /(catalog|comment|toolbar|header|footer|menu|aside|navigation|outline|sidebar)/i;
    const candidates = [...document.querySelectorAll('main, article, section, div')]
      .filter((node) => isVisible(node))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const cls = String(node.className || '');
        return rect.width > 480 && rect.height > 240 && !badClassPattern.test(cls);
      })
      .map((node) => {
        const pCount = node.querySelectorAll('p, h1, h2, h3, h4, li, blockquote').length;
        const imgCount = node.querySelectorAll('img').length;
        const score = textLength(node) + pCount * 20 + imgCount * 80;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.node ?? null;
  };

  const getScrollTarget = (root) => {
    let node = root;

    while (node && node !== document.body && node !== document.documentElement) {
      if (!(node instanceof HTMLElement)) {
        node = node.parentElement;
        continue;
      }

      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY || '';
      const canScroll = /(auto|scroll)/i.test(overflowY) && node.scrollHeight > node.clientHeight + 120;
      if (canScroll) {
        return { node, isWindow: false };
      }

      node = node.parentElement;
    }

    return { node: document.scrollingElement || document.documentElement, isWindow: true };
  };

  const getMaxScroll = (scrollTarget) => {
    if (scrollTarget.isWindow) {
      const root = document.scrollingElement || document.documentElement;
      return Math.max(0, root.scrollHeight - window.innerHeight);
    }

    const element = scrollTarget.node;
    return Math.max(0, element.scrollHeight - element.clientHeight);
  };

  const setScrollTop = (scrollTarget, top) => {
    if (scrollTarget.isWindow) {
      window.scrollTo(0, top);
      return;
    }
    scrollTarget.node.scrollTop = top;
  };

  const cleanInlineNode = (node) => {
    const cloned = node.cloneNode(true);
    const escapeText = (value) =>
      String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    cloned.querySelectorAll('script, style, noscript, iframe, canvas, video, audio, input, textarea, button').forEach((n) => {
      n.remove();
    });

    [...cloned.querySelectorAll('*')].forEach((n) => {
      n.removeAttribute('id');
      n.removeAttribute('class');
      n.removeAttribute('style');
      n.removeAttribute('data-testid');
      n.removeAttribute('data-offset-key');
      n.removeAttribute('contenteditable');
      n.removeAttribute('spellcheck');
    });

    if (cloned instanceof HTMLImageElement) {
      const src = normalizeUrl(
        firstNonEmpty([
          cloned.getAttribute('src'),
          cloned.getAttribute('data-src'),
          cloned.getAttribute('data-url'),
          cloned.getAttribute('data-lark-source'),
          cloned.getAttribute('data-origin-src')
        ])
      );
      if (!src) {
        return '';
      }
      const alt = escapeText(firstNonEmpty([cloned.getAttribute('alt'), cloned.getAttribute('data-alt')]));
      return `<p><img src="${escapeText(src)}"${alt ? ` alt="${alt}"` : ''} /></p>`;
    }

    const html = cloned.outerHTML || '';
    return html.trim();
  };

  const collectVisibleBlocks = (root, htmlSet, blocks, imageSet, imageList) => {
    if (!root) return;

    const nodes = [...root.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre, table, figure, img')].filter((node) => {
      if (!isVisible(node)) return false;
      if (node instanceof HTMLImageElement) return true;
      return textLength(node) > 3 || node.querySelector('img');
    });

    for (const node of nodes) {
      if (node instanceof HTMLImageElement) {
        const src = normalizeUrl(
          firstNonEmpty([
            node.getAttribute('src'),
            node.getAttribute('data-src'),
            node.getAttribute('data-url'),
            node.getAttribute('data-lark-source'),
            node.getAttribute('data-origin-src')
          ])
        );
        if (!src || imageSet.has(src)) {
          continue;
        }
        imageSet.add(src);
        imageList.push({
          index: imageList.length,
          src,
          alt: firstNonEmpty([node.getAttribute('alt'), node.getAttribute('data-alt')])
        });
      }

      const html = cleanInlineNode(node);
      if (!html) continue;

      const signature = `${node.tagName}:${normalizeText(node.textContent).slice(0, 300)}:${html.slice(0, 200)}`;
      if (htmlSet.has(signature)) {
        continue;
      }

      htmlSet.add(signature);
      blocks.push({
        html,
        text: normalizeText(node.textContent)
      });
    }
  };

  try {
    if (isLoginPage()) {
      throw new Error('飞书文档未登录，请先在飞书页面登录后重试');
    }

    let contentRoot = null;
    for (let attempt = 0; attempt < 140; attempt += 1) {
      contentRoot = findContentRoot();
      if (contentRoot && textLength(contentRoot) > 80) break;
      await sleep(180);
    }

    if (!contentRoot) {
      throw new Error('未定位到飞书文档正文区域，请滚动页面后重试');
    }

    const scrollTarget = getScrollTarget(contentRoot);
    const htmlSet = new Set();
    const imageSet = new Set();
    const blocks = [];
    const images = [];

    const viewport = scrollTarget.isWindow ? window.innerHeight : scrollTarget.node.clientHeight;
    const step = Math.max(300, Math.floor(viewport * 0.72));

    let position = 0;
    let maxScroll = getMaxScroll(scrollTarget);
    let guard = 0;

    while (position <= maxScroll + step && guard < 420) {
      setScrollTop(scrollTarget, position);
      await sleep(260);

      contentRoot = findContentRoot() || contentRoot;
      collectVisibleBlocks(contentRoot, htmlSet, blocks, imageSet, images);

      const nextMax = getMaxScroll(scrollTarget);
      maxScroll = Math.max(maxScroll, nextMax);
      position += step;
      guard += 1;
    }

    setScrollTop(scrollTarget, 0);
    await sleep(120);

    if (!blocks.length) {
      throw new Error('飞书正文提取为空，请确认文档已加载完成');
    }

    const title = firstNonEmpty([
      document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      document.querySelector('meta[name="twitter:title"]')?.getAttribute('content'),
      document.querySelector('[data-testid*="title"]')?.textContent,
      document.querySelector('h1')?.textContent,
      (document.title || '').replace(/\s*[-|_].*飞书.*$/i, ''),
      document.title
    ]);

    const contentHtml = blocks
      .map((item) => item.html)
      .filter(Boolean)
      .join('\n')
      .trim();
    const textPlain = blocks
      .map((item) => item.text)
      .filter(Boolean)
      .join('\n')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const wordCount = textPlain.replace(/\s+/g, '').length;
    const paragraphCount = blocks.length;
    const coverUrl = images.find((item) => item.src)?.src || '';

    const warnings = [];
    if (!coverUrl) warnings.push('未识别到封面图');
    if (wordCount === 0) warnings.push('正文字数为 0，可能提取失败');
    if (paragraphCount < 4) warnings.push('检测到段落较少，可能未完整加载全部正文');

    return {
      ok: true,
      data: {
        sourceUrl: location.href,
        title,
        coverUrl,
        contentHtml,
        textPlain,
        wordCount,
        paragraphCount,
        imageCount: images.length,
        images,
        validationHints: warnings
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
