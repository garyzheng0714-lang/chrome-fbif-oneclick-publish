export async function autoFillWechatEditorInPage(payload = {}) {
  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const stripHtml = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const minContentLength = Math.max(10, Number(payload?.minContentLength) || 0);
  const title = String(payload?.title || '').trim();
  const contentHtml = String(payload?.contentHtml || '').trim();
  const upstreamInsertPlan = Array.isArray(payload?.contentInsertPlan) ? payload.contentInsertPlan : [];
  const expectedImageTextRunSignature = String(payload?.imageTextRunSignature || '').trim();
  const expectedInsertSteps = Math.max(0, Number(payload?.expectedInsertSteps) || 0);
  const perfNow = () => (typeof performance?.now === 'function' ? performance.now() : Date.now());
  const perfMetrics = {
    totalMs: 0,
    titleWriteMs: 0,
    contentWriteMs: 0,
    splitMs: 0,
    verifyMs: 0,
    insertTextMs: 0,
    insertImageMs: 0,
    insertSteps: 0,
    attempts: 0,
    applyMethod: '',
    lightweightVerify: false
  };

  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const getNodeMarker = (node) =>
    normalizeText(
      [
        node?.getAttribute?.('placeholder') || '',
        node?.getAttribute?.('data-placeholder') || '',
        node?.getAttribute?.('aria-label') || '',
        node?.getAttribute?.('name') || '',
        node?.getAttribute?.('maxlength') || '',
        node?.id || '',
        node?.className || '',
        node?.textContent || ''
      ].join(' ')
    ).toLowerCase();

  const triggerInputEvents = (node, inputType = 'insertText', data = '') => {
    try {
      node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data }));
    } catch {
      // ignore unsupported InputEvent constructor
    }
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const replaceEditableContent = (node, nextHtml, nextText, useHtml) => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    try {
      node.focus();
      const selection = window.getSelection?.();
      if (selection) {
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.addRange(range);
      }

      let applied = false;
      if (useHtml && typeof document.execCommand === 'function') {
        applied = document.execCommand('insertHTML', false, nextHtml);
      } else if (typeof document.execCommand === 'function') {
        applied = document.execCommand('insertText', false, nextText);
      }

      if (!applied) {
        if (useHtml) {
          node.innerHTML = nextHtml;
        } else {
          node.textContent = nextText;
        }
      }

      triggerInputEvents(node, useHtml ? 'insertFromPaste' : 'insertText', useHtml ? '' : nextText);
      node.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const setNativeValue = (input, value) => {
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
      return false;
    }

    try {
      const nextValue = String(value ?? '');
      const prototype = Object.getPrototypeOf(input);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      input.focus();
      if (descriptor?.set) {
        descriptor.set.call(input, nextValue);
      } else {
        input.value = nextValue;
      }
      triggerInputEvents(input, 'insertText', nextValue);
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const scoreTitleNode = (node) => {
    if (!(node instanceof HTMLElement) || !isVisible(node)) {
      return -1;
    }

    const rect = node.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 20) {
      return -1;
    }

    const marker = getNodeMarker(node);
    let score = 0;
    if (/标题|title/.test(marker)) score += 320;
    if (/64|maxlength/.test(marker)) score += 120;
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) score += 120;
    if (node.isContentEditable) score += 160;
    if (rect.top < 420) score += 80;
    if (rect.width > 420) score += 60;
    if (/正文|content|editor/.test(marker)) score -= 220;
    score += Math.min(220, Math.round((rect.width * rect.height) / 6000));
    return score;
  };

  const resolveEditableTarget = (node) => {
    if (!(node instanceof HTMLElement)) {
      return null;
    }

    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable) {
      return node;
    }

    const innerEditable = node.querySelector(
      'input, textarea, [contenteditable="true"], [role="textbox"], .public-DraftEditor-content, .ql-editor'
    );
    if (innerEditable instanceof HTMLElement) {
      return innerEditable;
    }

    const parentEditable = node.closest(
      'input, textarea, [contenteditable="true"], [role="textbox"], .public-DraftEditor-content, .ql-editor'
    );
    if (parentEditable instanceof HTMLElement) {
      return parentEditable;
    }

    return null;
  };

  const findTitleCandidates = () => {
    const selectorList = [
      '#js_title_place',
      '#title',
      'input[name="title"]',
      '.title_input input',
      '.js_title',
      '[data-id="title"]',
      '.appmsg_title input',
      '.appmsg-edit-title input',
      '[data-placeholder*="请在这里输入标题"]',
      '[placeholder*="请在这里输入标题"]',
      'input[maxlength="64"]',
      'input[placeholder*="标题"]',
      'textarea[placeholder*="标题"]',
      '[contenteditable="true"][data-placeholder*="标题"]',
      '[contenteditable="true"][placeholder*="标题"]',
      '[contenteditable="true"][aria-label*="标题"]',
      '[contenteditable="true"]',
      '.weui-desktop-form__input',
      '.title',
      'input[type="text"]'
    ];

    const candidateSet = new Set();
    selectorList.forEach((selector) => {
      [...document.querySelectorAll(selector)].forEach((node) => {
        if (node instanceof HTMLElement) {
          candidateSet.add(node);
        }
      });
    });

    const candidates = [...candidateSet]
      .map((node) => ({
        node: resolveEditableTarget(node) || node,
        score: scoreTitleNode(node)
      }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);

    return candidates.map((item) => item.node).filter((node) => node instanceof HTMLElement);
  };

  const findUEditorInstance = () => {
    const ue = window.UE;
    if (!ue) {
      if (window.editor && typeof window.editor.setContent === 'function') {
        return window.editor;
      }
      return null;
    }

    const instantMap = ue.instants && typeof ue.instants === 'object' ? ue.instants : {};
    const instances = Object.values(instantMap).filter((item) => item && typeof item.setContent === 'function');
    if (instances.length > 0) {
      return instances[0];
    }

    if (typeof ue.getEditor === 'function') {
      try {
        const editors = [...document.querySelectorAll('[id]')]
          .map((node) => String(node.id || '').trim())
          .filter(Boolean)
          .map((id) => ue.getEditor(id))
          .filter((editor) => editor && typeof editor.setContent === 'function');
        if (editors.length > 0) {
          return editors[0];
        }
      } catch {
        // ignore
      }
    }

    return null;
  };

  const setByUEditor = async (editor, html) => {
    if (!editor || typeof editor.setContent !== 'function') {
      return false;
    }

    try {
      if (typeof editor.ready === 'function') {
        await new Promise((resolve) => {
          let resolved = false;
          const done = (value) => {
            if (resolved) return;
            resolved = true;
            resolve(Boolean(value));
          };

          try {
            editor.ready(() => {
              try {
                editor.setContent(html);
                done(true);
              } catch {
                done(false);
              }
            });
            setTimeout(() => done(false), 5000);
          } catch {
            done(false);
          }
        });
      } else {
        editor.setContent(html);
      }

      if (typeof editor.fireEvent === 'function') {
        editor.fireEvent('contentChange');
      }

      return true;
    } catch {
      return false;
    }
  };

  const invokeMpEditorJsApi = (apiName, apiParam) =>
    new Promise((resolve) => {
      try {
        const jsapi = window.__MP_Editor_JSAPI__;
        if (!jsapi || typeof jsapi.invoke !== 'function') {
          resolve({ ok: false, error: 'jsapi_not_available' });
          return;
        }

        jsapi.invoke({
          apiName,
          apiParam,
          sucCb: (result) => resolve({ ok: true, result }),
          errCb: (error) => resolve({ ok: false, error })
        });
      } catch (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

  const waitForMpEditorJsApi = async (timeoutMs = 10_000, intervalMs = 180) => {
    const deadline = Date.now() + Math.max(1200, timeoutMs);
    while (Date.now() < deadline) {
      const jsapi = window.__MP_Editor_JSAPI__;
      if (jsapi && typeof jsapi.invoke === 'function') {
        return true;
      }
      await sleep(intervalMs);
    }
    return false;
  };

  const parseMpEditorReadyState = (value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value > 0;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (!normalized) return null;
      if (['1', 'true', 'ready', 'ok', 'success'].includes(normalized)) return true;
      if (['0', 'false', 'not_ready', 'pending', 'loading'].includes(normalized)) return false;
      return null;
    }

    if (value && typeof value === 'object') {
      const candidates = [
        value.ready,
        value.isReady,
        value.isready,
        value.editorReady,
        value.editor_ready,
        value.status,
        value.code
      ];

      for (const candidate of candidates) {
        const parsed = parseMpEditorReadyState(candidate);
        if (parsed !== null) {
          return parsed;
        }
      }
    }

    return null;
  };

  const hasRichStructure = (html) =>
    /<(p|h[1-6]|ul|ol|li|blockquote|figure|img|table|pre|hr|section|article|div)\b/i.test(String(html || ''));

  const extractHtmlFromUnknown = (value, depth = 0) => {
    if (depth > 4 || value == null) {
      return '';
    }

    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized && /<[^>]+>/.test(normalized)) {
        return normalized;
      }
      return '';
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = extractHtmlFromUnknown(item, depth + 1);
        if (result) return result;
      }
      return '';
    }

    if (typeof value === 'object') {
      const preferredKeys = ['html', 'content', 'data', 'result', 'value', 'article', 'body'];
      for (const key of preferredKeys) {
        if (!(key in value)) {
          continue;
        }
        const result = extractHtmlFromUnknown(value[key], depth + 1);
        if (result) return result;
      }

      for (const nestedValue of Object.values(value)) {
        const result = extractHtmlFromUnknown(nestedValue, depth + 1);
        if (result) return result;
      }
    }

    return '';
  };

  const splitHtmlForMpEditor = (html, maxChunkLength = 12_000) => {
    const normalized = String(html || '').trim();
    if (!normalized) return [];
    if (normalized.length <= maxChunkLength) return [normalized];

    const chunks = [];
    let current = '';

    const flushCurrent = () => {
      if (!current) {
        return;
      }
      chunks.push(current);
      current = '';
    };

    const appendPiece = (piece) => {
      const fragment = String(piece || '').trim();
      if (!fragment) {
        return;
      }

      const hasInlineDataImage = /<img\b[^>]*\ssrc\s*=\s*['"]data:image\//i.test(fragment);
      if (hasInlineDataImage && fragment.length > maxChunkLength) {
        flushCurrent();
        chunks.push(fragment);
        return;
      }

      if (fragment.length > maxChunkLength) {
        const nestedPieces = fragment
          .split(/(?=<(?:p|h[1-6]|ul|ol|li|blockquote|figure|pre|table|section|article|div|img)\b)/gi)
          .map((item) => String(item || '').trim())
          .filter(Boolean);

        if (nestedPieces.length > 1) {
          nestedPieces.forEach((item) => appendPiece(item));
          return;
        }

        flushCurrent();
        for (let offset = 0; offset < fragment.length; offset += maxChunkLength) {
          chunks.push(fragment.slice(offset, offset + maxChunkLength));
        }
        return;
      }

      if (!current) {
        current = fragment;
        return;
      }

      if ((current + fragment).length > maxChunkLength) {
        flushCurrent();
        current = fragment;
        return;
      }

      current += fragment;
    };

    if (typeof document?.createElement === 'function') {
      try {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = normalized;

        const fragments = [];
        [...wrapper.childNodes].forEach((node) => {
          if (node instanceof HTMLElement) {
            fragments.push(node.outerHTML);
            return;
          }

          if (node?.nodeType === Node.TEXT_NODE) {
            const text = String(node.textContent || '').trim();
            if (!text) return;
            const paragraph = document.createElement('p');
            paragraph.textContent = text;
            fragments.push(paragraph.outerHTML);
          }
        });

        if (fragments.length > 0) {
          fragments.forEach((item) => appendPiece(item));
          flushCurrent();
          if (chunks.length > 0) {
            return chunks;
          }
        }
      } catch {
        // fallback to regex split
      }
    }

    const fallbackChunks = [];
    let fallbackCurrent = '';
    const tokens = normalized.split(
      /(?=<(?:p|h[1-6]|ul|ol|li|blockquote|figure|pre|table|section|article|div|img)\b)/gi
    );

    tokens.forEach((token) => {
      const piece = String(token || '');
      if (!piece) return;

      if (!fallbackCurrent) {
        fallbackCurrent = piece;
        return;
      }

      if ((fallbackCurrent + piece).length > maxChunkLength) {
        fallbackChunks.push(fallbackCurrent);
        fallbackCurrent = piece;
      } else {
        fallbackCurrent += piece;
      }
    });

    if (fallbackCurrent) {
      fallbackChunks.push(fallbackCurrent);
    }

    return fallbackChunks.length ? fallbackChunks : [normalized];
  };

  const hasImageTag = (chunk) => /<img\b/i.test(String(chunk || ''));
  const isDataImageChunk = (chunk) => /<img\b[^>]*\ssrc\s*=\s*['"]data:image\//i.test(String(chunk || ''));
  const buildImageTextRunSignatureInPage = (html, maxTokens = 320) => {
    const source = String(html || '').trim();
    if (!source) {
      return '';
    }
    const normalizedMaxTokens = Math.max(10, Number(maxTokens) || 320);
    const pattern = /<(img|p|h[1-6]|li|blockquote|pre|code)\b/gi;
    const signature = [];
    let match = null;
    while ((match = pattern.exec(source)) && signature.length < normalizedMaxTokens) {
      const marker = String(match[1] || '').toLowerCase() === 'img' ? 'I' : 'T';
      if (signature[signature.length - 1] !== marker) {
        signature.push(marker);
      }
    }
    return signature.join('');
  };
  const isImageTextRunCompatibleInPage = (expectedSignature, actualSignature) => {
    const expected = String(expectedSignature || '').trim();
    const actual = String(actualSignature || '').trim();
    if (!expected || !expected.includes('I')) {
      return true;
    }
    if (!actual || !actual.includes('I')) {
      return false;
    }
    if (expected === actual) {
      return true;
    }

    let cursor = 0;
    for (let index = 0; index < actual.length && cursor < expected.length; index += 1) {
      if (actual[index] === expected[cursor]) {
        cursor += 1;
      }
    }
    return cursor === expected.length;
  };
  const normalizeInsertPlan = (html) => {
    const normalizeStep = (step, index, fallbackYieldEvery = 4) => {
      const stepHtml = String(step?.html || '').trim();
      if (!stepHtml) {
        return null;
      }
      const hasImage = Boolean(step?.isImage || hasImageTag(stepHtml));
      const isDataImage = Boolean(step?.isDataImage || isDataImageChunk(stepHtml));
      return {
        html: stepHtml,
        isImage: hasImage,
        isDataImage,
        delayMs:
          hasImage
            ? Math.max(0, Number(step?.delayMs ?? (isDataImage ? 80 : 8)) || 0)
            : 0,
        yieldAfter: hasImage ? Boolean(step?.yieldAfter ?? true) : Boolean(step?.yieldAfter ?? ((index + 1) % fallbackYieldEvery === 0))
      };
    };

    if (Array.isArray(upstreamInsertPlan) && upstreamInsertPlan.length > 0) {
      const normalized = upstreamInsertPlan
        .map((step, index) => normalizeStep(step, index, 4))
        .filter(Boolean);
      if (normalized.length > 0) {
        return normalized;
      }
    }

    const chunks = splitHtmlForMpEditor(html, 12_000);
    return chunks
      .map((chunk, index) =>
        normalizeStep(
          {
            html: chunk,
            isImage: hasImageTag(chunk),
            isDataImage: isDataImageChunk(chunk),
            delayMs: hasImageTag(chunk) ? (isDataImageChunk(chunk) ? 80 : 8) : 0,
            yieldAfter: hasImageTag(chunk) ? true : (index + 1) % 4 === 0
          },
          index,
          4
        )
      )
      .filter(Boolean);
  };
  const expectedRunSignature = expectedImageTextRunSignature || buildImageTextRunSignatureInPage(contentHtml, 320);

  const readMpEditorHtml = async () => {
    const jsApiResult = await invokeMpEditorJsApi('mp_editor_get_content', {});
    if (jsApiResult.ok) {
      const extracted = extractHtmlFromUnknown(jsApiResult.result);
      if (extracted) {
        return extracted;
      }
    }

    const proseMirrorRoot = document.querySelector('.ProseMirror');
    if (proseMirrorRoot instanceof HTMLElement) {
      return String(proseMirrorRoot.innerHTML || '');
    }

    return '';
  };

  const waitForMpEditorReady = async (timeoutMs = 12_000, intervalMs = 220) => {
    const jsapiReady = await waitForMpEditorJsApi(timeoutMs, intervalMs);
    if (!jsapiReady) {
      return false;
    }

    const deadline = Date.now() + Math.max(2_000, timeoutMs);
    let unknownReadyChecks = 0;
    while (Date.now() < deadline) {
      const readyResult = await invokeMpEditorJsApi('mp_editor_get_isready', {});
      if (readyResult.ok) {
        const ready = parseMpEditorReadyState(readyResult.result);
        if (ready === true) {
          return true;
        }
        if (ready === null) {
          unknownReadyChecks += 1;
          if (unknownReadyChecks >= 2) {
            return true;
          }
        }
      }
      await sleep(intervalMs);
    }

    return false;
  };

  const countRenderableImagesFromHtml = (html) => {
    const source = String(html || '').trim();
    if (!source) {
      return 0;
    }

    try {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = source;
      return [...wrapper.querySelectorAll('img')]
        .filter((img) => {
          const src = String(img.getAttribute('src') || '').trim();
          return Boolean(src && src !== 'about:blank');
        })
        .length;
    } catch {
      const matches = source.match(/<img[^>]+\ssrc\s*=\s*(['"])\s*(?!\1)(.*?)\1/gi);
      return matches ? matches.length : 0;
    }
  };

  const verifyMpEditorInjection = async (sourceHtml, options = {}) => {
    const lightweight = Boolean(options?.lightweight);
    await sleep(180);
    const currentHtml = await readMpEditorHtml();
    if (!currentHtml) {
      return false;
    }

    const currentTextLength = stripHtml(currentHtml).length;
    if (currentTextLength < minContentLength) {
      return false;
    }

    const currentRunSignature = buildImageTextRunSignatureInPage(currentHtml, 320);
    if (!isImageTextRunCompatibleInPage(expectedRunSignature, currentRunSignature)) {
      return false;
    }

    if (lightweight) {
      return true;
    }

    if (!hasRichStructure(sourceHtml)) {
      return true;
    }

    if (!hasRichStructure(currentHtml)) {
      return false;
    }

    const expectedImageCount = countRenderableImagesFromHtml(sourceHtml);
    const currentImageCount = countRenderableImagesFromHtml(currentHtml);
    if (expectedImageCount > 0 && currentImageCount < expectedImageCount) {
      return false;
    }

    return true;
  };

  const verifyEditorHtml = (sourceHtml, currentHtml, options = {}) => {
    const lightweight = Boolean(options?.lightweight);
    const expectedHtml = String(sourceHtml || '');
    const actualHtml = String(currentHtml || '');
    if (!actualHtml.trim()) {
      return false;
    }

    const actualTextLength = stripHtml(actualHtml).length;
    if (actualTextLength < minContentLength) {
      return false;
    }

    const actualRunSignature = buildImageTextRunSignatureInPage(actualHtml, 320);
    if (!isImageTextRunCompatibleInPage(expectedRunSignature, actualRunSignature)) {
      return false;
    }

    if (lightweight) {
      return true;
    }

    if (!hasRichStructure(expectedHtml)) {
      return true;
    }

    if (!hasRichStructure(actualHtml)) {
      return false;
    }

    const expectedImageCount = countRenderableImagesFromHtml(expectedHtml);
    const actualImageCount = countRenderableImagesFromHtml(actualHtml);
    if (expectedImageCount > 0 && actualImageCount < expectedImageCount) {
      return false;
    }

    if (/<(ul|ol|blockquote|h[1-6])\b/i.test(expectedHtml) && !/<(ul|ol|blockquote|h[1-6])\b/i.test(actualHtml)) {
      return false;
    }

    return true;
  };

  const readProseMirrorHtml = () => {
    const node = document.querySelector('.ProseMirror');
    if (node instanceof HTMLElement) {
      return String(node.innerHTML || '');
    }
    return '';
  };

  const captureViewportState = () => {
    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
    return {
      x: Number(window.scrollX || 0),
      y: Number(window.scrollY || 0),
      top: Number(scrollingElement?.scrollTop || 0),
      left: Number(scrollingElement?.scrollLeft || 0)
    };
  };

  const restoreViewportState = (state) => {
    if (!state || typeof state !== 'object') {
      return;
    }

    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
    try {
      window.scrollTo(state.x || 0, state.y || 0);
    } catch {
      // ignore
    }

    if (scrollingElement) {
      try {
        scrollingElement.scrollTop = Number(state.top || 0);
        scrollingElement.scrollLeft = Number(state.left || 0);
      } catch {
        // ignore
      }
    }
  };

  const lockOverflowAnchor = () => {
    const htmlNode = document.documentElement;
    const bodyNode = document.body;
    const prosemirrorNode = document.querySelector('.ProseMirror');
    const nodes = [htmlNode, bodyNode, prosemirrorNode].filter((node) => node instanceof HTMLElement);
    const previous = nodes.map((node) => ({
      node,
      overflowAnchor: node.style.overflowAnchor || ''
    }));

    nodes.forEach((node) => {
      node.style.overflowAnchor = 'none';
    });

    return () => {
      previous.forEach((item) => {
        if (item?.node instanceof HTMLElement) {
          item.node.style.overflowAnchor = item.overflowAnchor;
        }
      });
    };
  };

  const focusWithoutScroll = (element) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    try {
      element.focus({ preventScroll: true });
      return;
    } catch {
      // ignore
    }

    try {
      element.focus();
    } catch {
      // ignore
    }
  };

  const setByProseMirrorPaste = async (html) => {
    const normalizedHtml = String(html || '').trim();
    if (!normalizedHtml) {
      return false;
    }

    const root = await waitForNode(() => {
      const node = document.querySelector('.ProseMirror');
      if (node instanceof HTMLElement && node.isContentEditable) {
        return node;
      }
      return null;
    }, 10_000, 180);
    if (!(root instanceof HTMLElement)) {
      return false;
    }

    const plainText = stripHtml(normalizedHtml);
    const viewportState = captureViewportState();
    const unlockOverflowAnchor = lockOverflowAnchor();
    const clearCurrentContent = () => {
      try {
        focusWithoutScroll(root);
        const selection = window.getSelection?.();
        if (selection) {
          selection.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(root);
          selection.addRange(range);
        }

        if (typeof document.execCommand === 'function') {
          document.execCommand('delete', false);
        } else {
          root.innerHTML = '';
        }
      } catch {
        root.innerHTML = '';
      }
    };

    const dispatchPasteEvent = () => {
      try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/html', normalizedHtml);
        dataTransfer.setData('text/plain', plainText);

        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer
        });
        return root.dispatchEvent(pasteEvent);
      } catch {
        return false;
      }
    };

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        clearCurrentContent();
        focusWithoutScroll(root);

        let pasted = dispatchPasteEvent();
        if (!pasted && typeof document.execCommand === 'function') {
          try {
            pasted = document.execCommand('insertHTML', false, normalizedHtml);
          } catch {
            pasted = false;
          }
        }

        if (!pasted) {
          try {
            const fragment = document.createRange().createContextualFragment(normalizedHtml);
            root.innerHTML = '';
            root.appendChild(fragment);
            pasted = true;
          } catch {
            pasted = false;
          }
        }

        triggerInputEvents(root, 'insertFromPaste', '');
        restoreViewportState(viewportState);
        await sleep(220);

        const currentHtml = readProseMirrorHtml();
        const useLightweightVerify = new TextEncoder().encode(normalizedHtml).length > 420 * 1024;
        if (pasted && verifyEditorHtml(normalizedHtml, currentHtml, { lightweight: useLightweightVerify })) {
          restoreViewportState(viewportState);
          return true;
        }
      }
    } finally {
      unlockOverflowAnchor();
      restoreViewportState(viewportState);
    }

    return false;
  };

  const setByMpEditorJsApi = async (html) => {
    const normalizedHtml = String(html || '').trim();
    if (!normalizedHtml) {
      return false;
    }

    const jsapiReady = await waitForMpEditorReady(12_000, 220);
    if (!jsapiReady) {
      return false;
    }

    // 严格按源文顺序插入，避免“文本先插、图片后插”导致图片堆到底部。
    const splitStart = perfNow();
    const insertPlan = normalizeInsertPlan(normalizedHtml);
    perfMetrics.splitMs += perfNow() - splitStart;
    perfMetrics.insertSteps = insertPlan.length;
    if (!insertPlan.length) {
      return false;
    }
    const imageStepCount = insertPlan.filter((step) => Boolean(step?.isImage)).length;
    const contentBytes = new TextEncoder().encode(normalizedHtml).length;
    const skipSetContentForLargePayload = contentBytes > 420 * 1024;
    const useLightweightVerify =
      skipSetContentForLargePayload || insertPlan.length > 180 || imageStepCount > 40;
    perfMetrics.lightweightVerify = useLightweightVerify;
    const viewportState = captureViewportState();
    const unlockOverflowAnchor = lockOverflowAnchor();

    const insertChunkList = async (planList = []) => {
      const list = Array.isArray(planList) ? planList : [];
      if (!list.length) {
        return true;
      }

      for (let index = 0; index < list.length; index += 1) {
        const step = list[index];
        const htmlChunk = String(step?.html || '');
        if (!htmlChunk) {
          continue;
        }
        const trackerKey = step?.isImage ? 'insertImageMs' : 'insertTextMs';
        const stepStart = perfNow();
        const insertResult = await invokeMpEditorJsApi('mp_editor_insert_html', {
          html: htmlChunk
        });
        perfMetrics[trackerKey] += perfNow() - stepStart;
        if (!insertResult.ok) {
          return false;
        }

        const stepDelayMs = Math.max(0, Number(step?.delayMs) || 0);
        if (stepDelayMs > 0) {
          await sleep(stepDelayMs);
        } else if (step?.yieldAfter) {
          await sleep(0);
        }
      }
      return true;
    };

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        perfMetrics.attempts += 1;
        if (!skipSetContentForLargePayload) {
          const setStart = perfNow();
          const setResult = await invokeMpEditorJsApi('mp_editor_set_content', { content: normalizedHtml });
          perfMetrics.contentWriteMs += perfNow() - setStart;
          const verifyStart = perfNow();
          const verifiedBySetContent = setResult.ok
            ? await verifyMpEditorInjection(normalizedHtml, { lightweight: useLightweightVerify })
            : false;
          perfMetrics.verifyMs += perfNow() - verifyStart;
          if (verifiedBySetContent) {
            restoreViewportState(viewportState);
            return true;
          }
        }

        const clearStart = perfNow();
        const clearResult = await invokeMpEditorJsApi('mp_editor_set_content', { content: '' });
        perfMetrics.contentWriteMs += perfNow() - clearStart;
        if (!clearResult.ok) {
          await sleep(180);
          continue;
        }

        const inserted = await insertChunkList(insertPlan);
        if (!inserted) {
          await sleep(180);
          continue;
        }

        const verifyStart = perfNow();
        const verifiedByChunkInsert = await verifyMpEditorInjection(normalizedHtml, {
          lightweight: useLightweightVerify
        });
        perfMetrics.verifyMs += perfNow() - verifyStart;
        if (verifiedByChunkInsert) {
          restoreViewportState(viewportState);
          return true;
        }

        await sleep(180);
      }
    } finally {
      unlockOverflowAnchor();
      restoreViewportState(viewportState);
    }

    return false;
  };

  const setByIframeEditor = (html) => {
    const iframes = [...document.querySelectorAll('iframe')];
    for (const iframe of iframes) {
      const marker = `${iframe.id || ''} ${iframe.className || ''} ${iframe.name || ''}`.toLowerCase();
      if (!/ueditor|editor|rich|content/.test(marker)) {
        continue;
      }

      const doc = iframe.contentDocument;
      const body = doc?.body;
      if (!body) {
        continue;
      }

      try {
        body.focus();
        body.innerHTML = html;
        triggerInputEvents(body, 'insertFromPaste', '');
        return true;
      } catch {
        // ignore
      }
    }
    return false;
  };

  const scoreContentNode = (node, titleNode) => {
    if (!(node instanceof HTMLElement) || !isVisible(node) || node === titleNode || node.contains(titleNode)) {
      return -1;
    }

    const rect = node.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 100) {
      return -1;
    }

    const marker = getNodeMarker(node);
    let score = 0;
    if (/正文|content|editor|rich|draft|ql-editor/.test(marker)) score += 420;
    if (/从这里开始写正文/.test(marker)) score += 620;
    if (rect.top > 180) score += 120;
    if (rect.width > 520) score += 140;
    score += Math.min(500, Math.round((rect.width * rect.height) / 12000));
    if (/标题|title|maxlength=64/.test(marker)) score -= 260;
    return score;
  };

  const findContentCandidates = (titleNode) => {
    const selectorList = [
      '#ueditor_0',
      'iframe[id^="ueditor"]',
      '.edui-editor iframe',
      'iframe.edui-body-container',
      '.edui-body-container',
      '.appmsg-edit-content',
      '.rich_media_content',
      '#js_content',
      '[data-placeholder*="从这里开始写正文"]',
      '[placeholder*="从这里开始写正文"]',
      '[contenteditable="true"][data-placeholder*="正文"]',
      '[contenteditable="true"][placeholder*="正文"]',
      '[contenteditable="true"][aria-label*="正文"]',
      '.ql-editor',
      '.public-DraftEditor-content',
      '.editor_content',
      '.ProseMirror',
      '[role="textbox"]',
      '[contenteditable="true"]'
    ];

    const candidateSet = new Set();
    selectorList.forEach((selector) => {
      [...document.querySelectorAll(selector)].forEach((node) => {
        if (node instanceof HTMLElement) {
          candidateSet.add(node);
        }
      });
    });

    const scored = [...candidateSet]
      .map((node) => ({
        node,
        score: scoreContentNode(node, titleNode)
      }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);

    return scored.map((item) => resolveEditableTarget(item.node) || item.node).filter((node) => node instanceof HTMLElement);
  };

  const setByContentEditable = (html, titleNode) => {
    const candidates = findContentCandidates(titleNode);
    if (!candidates.length) {
      return { ok: false, node: null };
    }

    const plainText = stripHtml(html);
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }
      const ok = replaceEditableContent(candidate, html, plainText, true);
      if (ok) {
        return { ok: true, node: candidate };
      }
    }

    return { ok: false, node: null };
  };

  const readContentLength = (contentNode) => {
    const editor = findUEditorInstance();
    if (editor && typeof editor.getContentTxt === 'function') {
      try {
        return normalizeText(editor.getContentTxt()).length;
      } catch {
        // ignore
      }
    }

    if (contentNode instanceof HTMLElement) {
      return normalizeText(contentNode.innerText || contentNode.textContent || '').length;
    }

    const editable = findContentCandidates(null)[0];
    if (editable instanceof HTMLElement) {
      return normalizeText(editable.innerText || editable.textContent || '').length;
    }

    for (const iframe of [...document.querySelectorAll('iframe')]) {
      const body = iframe.contentDocument?.body;
      if (body) {
        const length = normalizeText(body.innerText || body.textContent || '').length;
        if (length > 0) {
          return length;
        }
      }
    }

    return 0;
  };

  const waitForNode = async (resolver, timeoutMs = 10_000, intervalMs = 180) => {
    const deadline = Date.now() + Math.max(1200, timeoutMs);
    while (Date.now() < deadline) {
      const node = resolver();
      if (node) {
        return node;
      }
      await sleep(intervalMs);
    }
    return null;
  };

  try {
    const fillStart = perfNow();
    if (!title) {
      return {
        ok: false,
        code: 'WX_FILL_TITLE_FAILED',
        error: '标题为空，无法同步到公众号'
      };
    }

    if (!contentHtml) {
      return {
        ok: false,
        code: 'WX_FILL_CONTENT_FAILED',
        error: '正文为空，无法同步到公众号'
      };
    }

    const titleCandidates = await waitForNode(() => {
      const candidates = findTitleCandidates();
      return candidates.length ? candidates : null;
    }, 12_000, 220);
    if (!titleCandidates || !titleCandidates.length) {
      return {
        ok: false,
        code: 'WX_FILL_TITLE_FAILED',
        error: '未定位到公众号标题输入框'
      };
    }

    const titleWriteStart = perfNow();
    let titleField = null;
    let titleApplied = false;
    for (const candidate of titleCandidates) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }
      const applied =
        (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement)
          ? setNativeValue(candidate, title)
          : replaceEditableContent(candidate, title, title, false);
      if (applied) {
        titleField = candidate;
        titleApplied = true;
        break;
      }
    }
    perfMetrics.titleWriteMs += perfNow() - titleWriteStart;

    if (!titleApplied) {
      return {
        ok: false,
        code: 'WX_FILL_TITLE_FAILED',
        error: '公众号标题写入失败'
      };
    }

    const editor = findUEditorInstance();
    const isModernWechatEditor =
      /appmsg_edit_v2/i.test(location.href) || document.querySelector('.ProseMirror') instanceof HTMLElement;
    const contentBytes = new TextEncoder().encode(contentHtml).length;
    const contentImageCount = countRenderableImagesFromHtml(contentHtml);
    const shouldPreferPasteFirst = isModernWechatEditor && (contentBytes > 320 * 1024 || contentImageCount > 18);
    const shouldFallbackToManualPaste =
      contentBytes > 5 * 1024 * 1024 || contentImageCount > 120;
    let contentApplied = false;
    let applyMethod = '';
    let appliedContentNode = null;
    const contentWriteStart = perfNow();

    if (shouldFallbackToManualPaste) {
      return {
        ok: false,
        code: 'WX_FILL_CONTENT_FAILED',
        error: '正文内容过大，已建议使用手动粘贴方式导入'
      };
    }

    if (shouldPreferPasteFirst) {
      contentApplied = await setByProseMirrorPaste(contentHtml);
      if (contentApplied) {
        applyMethod = 'prosemirror_paste';
      }

      if (!contentApplied) {
        contentApplied = await setByMpEditorJsApi(contentHtml);
        if (contentApplied) {
          applyMethod = 'mp_editor_jsapi';
        }
      }
    } else {
      contentApplied = await setByMpEditorJsApi(contentHtml);
      if (contentApplied) {
        applyMethod = 'mp_editor_jsapi';
      }

      if (!contentApplied && isModernWechatEditor) {
        contentApplied = await setByProseMirrorPaste(contentHtml);
        if (contentApplied) {
          applyMethod = 'prosemirror_paste';
        }
      }
    }

    if (!contentApplied && editor && !isModernWechatEditor) {
      contentApplied = await setByUEditor(editor, contentHtml);
      if (contentApplied) {
        applyMethod = 'ueditor';
      }
    }

    if (!contentApplied && !isModernWechatEditor) {
      contentApplied = setByIframeEditor(contentHtml);
      if (contentApplied) {
        applyMethod = 'iframe';
      }
    }

    if (!contentApplied && !isModernWechatEditor) {
      const result = setByContentEditable(contentHtml, titleField);
      contentApplied = result.ok;
      appliedContentNode = result.node;
      if (contentApplied) {
        applyMethod = 'dom';
      }
    }

    if (applyMethod !== 'mp_editor_jsapi') {
      perfMetrics.contentWriteMs += perfNow() - contentWriteStart;
    }

    if (!contentApplied) {
      if (isModernWechatEditor) {
        return {
          ok: false,
          code: 'WX_FILL_CONTENT_FAILED',
          error: '公众号编辑器暂未就绪，请在编辑页停留 1-2 秒后点击“重新同步公众号”'
        };
      }

      return {
        ok: false,
        code: 'WX_FILL_CONTENT_FAILED',
        error: '未定位到公众号正文编辑区域'
      };
    }

    perfMetrics.applyMethod = applyMethod;
    await sleep(260);

    const titleLength = normalizeText(
      titleField instanceof HTMLInputElement || titleField instanceof HTMLTextAreaElement
        ? titleField.value
        : titleField?.innerText || titleField?.textContent || ''
    ).length;
    const contentLength = readContentLength(appliedContentNode);

    if (!titleLength) {
      return {
        ok: false,
        code: 'WX_FILL_TITLE_FAILED',
        error: '公众号标题填充未生效'
      };
    }

    if (contentLength < minContentLength) {
      return {
        ok: false,
        code: 'WX_FILL_CONTENT_FAILED',
        error: '公众号正文填充未生效'
      };
    }

    perfMetrics.totalMs = perfNow() - fillStart;
    return {
      ok: true,
      detail: {
        titleLength,
        contentLength,
        applyMethod,
        performance: {
          totalMs: Math.round(perfMetrics.totalMs),
          titleWriteMs: Math.round(perfMetrics.titleWriteMs),
          contentWriteMs: Math.round(perfMetrics.contentWriteMs),
          splitMs: Math.round(perfMetrics.splitMs),
          verifyMs: Math.round(perfMetrics.verifyMs),
          insertTextMs: Math.round(perfMetrics.insertTextMs),
          insertImageMs: Math.round(perfMetrics.insertImageMs),
          insertSteps: Number(perfMetrics.insertSteps || 0),
          expectedInsertSteps: Number(expectedInsertSteps || 0),
          attempts: Number(perfMetrics.attempts || 0),
          lightweightVerify: Boolean(perfMetrics.lightweightVerify),
          applyMethod: perfMetrics.applyMethod
        }
      }
    };
  } catch (error) {
    return {
      ok: false,
      code: 'WX_UNKNOWN',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function extractWechatArticleInPage(manualSelector) {
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

export async function extractFeishuDocInPage(manualSelector) {
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
