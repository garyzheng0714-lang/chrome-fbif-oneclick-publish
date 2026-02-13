import { PLATFORM_ADAPTER_MAP } from './src/publishers/index.js';

const APP_PAGE_URL = chrome.runtime.getURL('app.html');
const FALLBACK_PAGE_URL = chrome.runtime.getURL('fallback.html');

const LOG_KEY = 'fbif_logs_v1';
const CACHE_KEY = 'fbif_cache_v1';
const FAILED_DRAFT_KEY = 'fbif_failed_drafts_v1';

const EXTRACTION_TIMEOUT_MS = 45_000;
const TAB_LOAD_TIMEOUT_MS = 35_000;
const EXTRACTION_RETRY_LIMIT = 2;
const PUBLISH_RETRY_LIMIT = 2;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ITEMS = 20;
const MAX_LOG_ITEMS = 400;
const MAX_FAILED_DRAFTS = 50;

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

chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({ url: APP_PAGE_URL });
});

chrome.runtime.onInstalled.addListener(() => {
  appendLog('info', 'system', '扩展已安装，可通过工具栏图标打开分发页面').catch(() => undefined);
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
    default:
      throw new Error('不支持的消息类型');
  }
}

async function extractArticle({
  url,
  manualSelector = '',
  forceRefresh = false,
  followTabs = true,
  sourceTabId = null
}) {
  if (!url || typeof url !== 'string') {
    throw new Error('请输入公众号文章链接');
  }

  const normalizedUrl = url.trim();
  if (!isWechatArticleUrl(normalizedUrl)) {
    throw new Error('链接格式无效，仅支持 mp.weixin.qq.com 文章链接');
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
      await appendLog('info', 'extract', `开始提取公众号内容（第 ${attempt} 次）`, {
        url: normalizedUrl,
        manualSelector
      });

      const rawData = await withTimeout(
        extractByTabInjection(normalizedUrl, manualSelector, { followTabs, sourceTabId }),
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
    await delay(1200);

    const executionResult = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractWechatArticleInPage,
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

  if (!article?.coverUrl) {
    warnings.push('未识别到封面图，可手动上传封面');
  }

  if (Array.isArray(article?.images)) {
    const invalidImages = article.images.filter((image) => !image?.src);
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

async function publishContent({ platformIds = [], content = {}, followTabs = true, sourceTabId = null }) {
  if (!Array.isArray(platformIds) || platformIds.length === 0) {
    throw new Error('请至少选择一个发布平台');
  }

  const uniquePlatformIds = [...new Set(platformIds)].filter((id) => Boolean(PLATFORMS[id]));
  if (uniquePlatformIds.length === 0) {
    throw new Error('未识别到可用平台');
  }

  const normalizedContent = normalizeContentPayload(content);

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
    coverUrl,
    contentHtml,
    textPlain,
    images
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

  if (!adapterResult?.ok) {
    throw new Error(adapterResult?.error || `${platform.name} 自动填充失败`);
  }

  return {
    tabId,
    warnings: adapterResult.warnings ?? [],
    detail: adapterResult.detail ?? {}
  };
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
