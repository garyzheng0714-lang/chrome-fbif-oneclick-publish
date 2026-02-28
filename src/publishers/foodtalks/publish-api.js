import { FOODTALKS_SELECTORS } from './selectors.js';
import { demoteHeadingsByOneLevel } from '../shared/heading-normalizer.js';

const PAGE_READY_TIMEOUT_MS = 70_000;
const IMPORT_WAIT_TIMEOUT_MS = 90_000;

export async function publishFoodtalks({ tabId, payload, runtime }) {
  if (!tabId) {
    return { ok: false, error: 'FoodTalks 发布页未打开' };
  }

  const runResult = await runtime.executeInTab({
    tabId,
    func: autoFillFoodtalksPublishPage,
    args: [
      {
        ...payload,
        selectors: FOODTALKS_SELECTORS,
        pageReadyTimeoutMs: PAGE_READY_TIMEOUT_MS,
        importWaitTimeoutMs: IMPORT_WAIT_TIMEOUT_MS
      }
    ],
    timeoutMs: 320_000
  });

  const result = runResult?.[0]?.result;
  if (!result?.ok) {
    return {
      ok: false,
      code: result?.code || '',
      error: result?.error || 'FoodTalks 自动填充失败'
    };
  }

  return {
    ok: true,
    warnings: result.warnings || [],
    detail: result.detail || {}
  };
}

async function autoFillFoodtalksPublishPage(payload = {}) {
  const selectors = payload.selectors || {};
  const warnings = [];

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isWechatUrl = (value) => /^https?:\/\/mp\.weixin\.qq\.com\//i.test(String(value || '').trim());
  const coerceSafeUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^data:image\//i.test(raw)) return raw;
    if (/^\/\//.test(raw)) return `https:${raw}`;
    if (/^(https?:|blob:)/i.test(raw)) return raw;
    return '';
  };
  const escapeHtml = (value) =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const queryVisible = (selectorList = []) => {
    for (const selector of selectorList) {
      const nodes = [...document.querySelectorAll(selector)];
      const hit = nodes.find((node) => isVisible(node));
      if (hit) return hit;
    }
    return null;
  };

  const findButtonByText = (keywords = [], scope = document) => {
    const nodes = [...scope.querySelectorAll('button, [role="button"], .el-button, a, span')].filter((node) =>
      isVisible(node)
    );

    for (const keyword of keywords) {
      const hit = nodes.find((node) => normalizeText(node.textContent).includes(keyword));
      if (hit) return hit;
    }

    return null;
  };

  const clickLikeUser = (node) => {
    if (!node) return false;

    try {
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
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

  const setNativeValue = (input, value) => {
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
      return false;
    }

    const nextValue = String(value ?? '');
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    try {
      input.focus();
      if (descriptor?.set) {
        descriptor.set.call(input, nextValue);
      } else {
        input.value = nextValue;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const setEditableText = (node, value) => {
    if (!(node instanceof HTMLElement) || !node.isContentEditable) {
      return false;
    }

    try {
      node.focus();
      node.innerHTML = '';
      node.textContent = String(value ?? '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const getNodeMarkerText = (node) => {
    if (!(node instanceof HTMLElement)) {
      return '';
    }

    const parts = [
      node.textContent || '',
      node.getAttribute('title') || '',
      node.getAttribute('aria-label') || '',
      node.getAttribute('aria-describedby') || '',
      node.getAttribute('data-menu-key') || '',
      node.getAttribute('data-command') || '',
      node.className || ''
    ];

    return normalizeText(parts.join(' '));
  };

  const waitUntil = async (predicate, timeoutMs = 20_000, intervalMs = 250) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = predicate();
        if (value) return value;
      } catch {
        // ignore probing error
      }
      await sleep(intervalMs);
    }
    return null;
  };

  const findFormItemByLabel = (labelKeywords = []) => {
    const labelNodes = [...document.querySelectorAll('.el-form-item__label, label')].filter((node) => isVisible(node));

    for (const labelKeyword of labelKeywords) {
      const labelNode = labelNodes.find((node) => normalizeText(node.textContent).includes(labelKeyword));
      if (!labelNode) continue;

      const formItem = labelNode.closest('.el-form-item');
      if (formItem) return formItem;
    }

    return null;
  };

  const findTitleInput = () => {
    const titleFormItem = findFormItemByLabel(selectors.titleLabelKeywords || ['标题']);
    if (titleFormItem) {
      const input = titleFormItem.querySelector('input, textarea');
      if (input && isVisible(input)) return input;
    }

    const fallback = queryVisible(selectors.titleInputCandidates || []);
    if (fallback instanceof HTMLInputElement || fallback instanceof HTMLTextAreaElement) {
      return fallback;
    }

    return null;
  };

  const getTinymceEditor = () => {
    const tiny = window.tinymce;
    if (!tiny) return null;

    const editors = Array.isArray(tiny.editors) ? tiny.editors : [];
    const visibleEditor = editors.find((editor) => {
      try {
        const body = editor?.getBody?.();
        return body && isVisible(body);
      } catch {
        return false;
      }
    });

    return visibleEditor || tiny.activeEditor || null;
  };

  const getEditorTextLength = () => {
    const tinyEditor = getTinymceEditor();
    if (tinyEditor) {
      try {
        return normalizeText(tinyEditor.getContent({ format: 'text' })).length;
      } catch {
        // ignore tiny read failure
      }
    }

    const iframe = queryVisible(selectors.editorIframeCandidates || []);
    if (iframe instanceof HTMLIFrameElement) {
      try {
        const text = iframe.contentDocument?.body?.innerText || '';
        return normalizeText(text).length;
      } catch {
        // ignore cross-frame failure
      }
    }

    const editable = queryVisible(selectors.editorContentEditableCandidates || []);
    if (editable) {
      return normalizeText(editable.textContent).length;
    }

    return 0;
  };

  const setEditorContent = (html) => {
    const finalHtml = adaptHtmlForFoodtalksEditor(html);
    if (!finalHtml) return false;

    const tinyEditor = getTinymceEditor();
    if (tinyEditor) {
      try {
        tinyEditor.focus();
        tinyEditor.setContent(finalHtml);
        tinyEditor.fire('input');
        tinyEditor.fire('change');
        tinyEditor.save?.();
        return true;
      } catch {
        // fallback to iframe/contenteditable
      }
    }

    const iframe = queryVisible(selectors.editorIframeCandidates || []);
    if (iframe instanceof HTMLIFrameElement) {
      try {
        const body = iframe.contentDocument?.body;
        if (body) {
          body.innerHTML = finalHtml;
          body.dispatchEvent(new Event('input', { bubbles: true }));
          body.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      } catch {
        // ignore iframe write failure
      }
    }

    const editable = queryVisible(selectors.editorContentEditableCandidates || []);
    if (editable) {
      editable.innerHTML = finalHtml;
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    return false;
  };

  const findSourceCodeButton = () => {
    const fromSelector = queryVisible(selectors.sourceCodeButtonCandidates || []);
    if (fromSelector) {
      return fromSelector;
    }

    const byText = findButtonByText(['源代码', '源码', 'Source code']);
    if (byText) {
      return byText;
    }

    return null;
  };

  const collectSourceCodeToolbarButtons = () => {
    const toolbarSelectors = [
      '.tox-toolbar',
      '.tox-toolbar__primary',
      '.w-e-toolbar',
      '.w-e-bar',
      '.ql-toolbar',
      '.editor-toolbar',
      '.editor__toolbar',
      '.edui-toolbar',
      '.ck-toolbar'
    ];
    const buttonSelectors = 'button, [role="button"], .tox-tbtn, .w-e-menu, .w-e-bar-item, a';
    const labelPattern = /(源代码|源码|source\s*code|html|代码)/i;
    const iconPattern = /(source|code|html|源码|源代码|icon-code|fa-code|ri-code)/i;

    const candidates = [];
    const seen = new Set();

    const genericToolbars = [...document.querySelectorAll('div, section')]
      .filter((node) => {
        if (!isVisible(node)) {
          return false;
        }
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width < 520 || rect.height < 28 || rect.height > 180) {
          return false;
        }
        const clickableCount = node.querySelectorAll('button, [role="button"], .w-e-menu, .w-e-bar-item, a').length;
        return clickableCount >= 10;
      })
      .slice(0, 16);

    const toolbarNodes = new Set([
      ...toolbarSelectors.flatMap((selector) => [...document.querySelectorAll(selector)].filter((node) => isVisible(node))),
      ...genericToolbars
    ]);

    [...toolbarNodes].forEach((toolbar) => {
      const buttons = [...toolbar.querySelectorAll(buttonSelectors)].filter((node) => isVisible(node));
      buttons.forEach((button, index) => {
        if (!(button instanceof HTMLElement) || seen.has(button)) {
          return;
        }
        seen.add(button);

        const marker = getNodeMarkerText(button);
        let score = 0;
        if (labelPattern.test(marker)) {
          score += 120;
        }
        if (iconPattern.test(marker)) {
          score += 80;
        }
        if (/[<＜]\s*\/?\s*[>＞]/.test(marker) || /&lt;\s*\/?\s*&gt;/i.test(button.innerHTML || '')) {
          score += 90;
        }
        if (index === 0) {
          score += 16;
        }

        candidates.push({ button, score, index });
      });
    });

    return candidates
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.button);
  };

  const findSourceCodeDialog = () => {
    const fromSelector = queryVisible(selectors.sourceCodeDialogCandidates || []);
    if (fromSelector) {
      const hasInput = Boolean(
        fromSelector.querySelector('textarea, input, [contenteditable="true"], .CodeMirror textarea')
      );
      if (hasInput) {
        return fromSelector;
      }
    }

    const candidates = [
      ...document.querySelectorAll('.tox-dialog, .el-dialog, .el-dialog__wrapper, .w-e-modal, [role="dialog"]')
    ].filter((node) => isVisible(node));

    return (
      candidates.find((node) => {
        const hasInput = Boolean(node.querySelector('textarea, input, [contenteditable="true"], .CodeMirror textarea'));
        if (!hasInput) {
          return false;
        }
        const marker = [
          node.getAttribute('aria-label') || '',
          node.getAttribute('title') || '',
          normalizeText(node.textContent || '')
        ].join(' ');
        return /(源代码|源码|source\s*code|html|代码)/i.test(marker);
      }) || null
    );
  };

  const findSourceCodeDialogByTextarea = () => {
    const textareas = [...document.querySelectorAll('textarea')]
      .filter((node) => isVisible(node))
      .map((node) => ({
        node,
        rect: node.getBoundingClientRect()
      }))
      .filter(({ rect }) => rect.width >= 420 && rect.height >= 200)
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);

    const candidate = textareas[0]?.node || null;
    if (!candidate) {
      return null;
    }

    const container =
      candidate.closest('.el-dialog, .el-dialog__wrapper, .tox-dialog, .w-e-modal, [role="dialog"]') ||
      candidate.parentElement;
    if (!(container instanceof HTMLElement)) {
      return null;
    }

    const marker = normalizeText(container.textContent || '');
    if (/(源代码|源码|source\s*code|html|代码)/i.test(marker)) {
      return container;
    }

    const overlayVisible = Boolean(
      [...document.querySelectorAll('.v-modal, .el-overlay, .modal-backdrop, .tox-dialog-wrap')]
        .filter((node) => isVisible(node)).length
    );

    return overlayVisible ? container : null;
  };

  const setSourceCodeInputValue = (dialog, html) => {
    if (!(dialog instanceof HTMLElement)) {
      return false;
    }

    const scopedCandidates = selectors.sourceCodeInputCandidates || [];
    const fromSelector = scopedCandidates
      .map((selector) => [...dialog.querySelectorAll(selector)].find((node) => isVisible(node)))
      .find(Boolean);
    const inputNode =
      fromSelector ||
      dialog.querySelector('textarea, .CodeMirror textarea, input[type="text"], input:not([type]), [contenteditable="true"]');

    if (!inputNode) {
      return false;
    }

    if (inputNode instanceof HTMLTextAreaElement || inputNode instanceof HTMLInputElement) {
      return setNativeValue(inputNode, html);
    }

    if (inputNode instanceof HTMLElement && inputNode.isContentEditable) {
      return setEditableText(inputNode, html);
    }

    return false;
  };

  const clickSourceCodeSave = (dialog) => {
    const fromSelector = queryVisible(selectors.sourceCodeSaveButtonCandidates || []);
    if (fromSelector && dialog?.contains(fromSelector)) {
      return clickLikeUser(fromSelector);
    }

    const button = findButtonByText(['保存', '确定', '确认', '应用', 'Save', 'Apply'], dialog || document);
    return clickLikeUser(button);
  };

  const tryOpenSourceCodeDialog = async () => {
    const existedDialog = findSourceCodeDialog();
    if (existedDialog) {
      return existedDialog;
    }

    const textareaDialog = findSourceCodeDialogByTextarea();
    if (textareaDialog) {
      return textareaDialog;
    }

    const tinyEditor = getTinymceEditor();
    if (tinyEditor?.execCommand) {
      try {
        tinyEditor.execCommand('mceCodeEditor');
      } catch {
        // ignore command failure
      }

      const tinyDialog = await waitUntil(() => findSourceCodeDialog(), 1_400, 120);
      if (tinyDialog) {
        return tinyDialog;
      }
    }

    const directButton = findSourceCodeButton();
    if (directButton && clickLikeUser(directButton)) {
      const directDialog = await waitUntil(
        () => findSourceCodeDialog() || findSourceCodeDialogByTextarea(),
        1_600,
        120
      );
      if (directDialog) {
        return directDialog;
      }
    }

    const toolbarButtons = collectSourceCodeToolbarButtons();
    const attempts = toolbarButtons.slice(0, 10);
    for (const button of attempts) {
      if (!clickLikeUser(button)) {
        continue;
      }

      const dialog = await waitUntil(
        () => findSourceCodeDialog() || findSourceCodeDialogByTextarea(),
        1_200,
        120
      );
      if (dialog) {
        return dialog;
      }
    }

    return null;
  };

  const setEditorContentBySourceCode = async (html) => {
    const finalHtml = adaptHtmlForFoodtalksEditor(html);
    if (!finalHtml) {
      return false;
    }

    const dialog = await tryOpenSourceCodeDialog();
    if (!dialog) {
      return false;
    }

    const valueSet = setSourceCodeInputValue(dialog, finalHtml);
    if (!valueSet) {
      return false;
    }

    const saveClicked = clickSourceCodeSave(dialog);
    if (!saveClicked) {
      return false;
    }

    await waitUntil(() => getEditorTextLength() > 10, 8_000, 220);
    return true;
  };

  const adaptHtmlForFoodtalksEditor = (rawHtml) => {
    const sourceHtml = String(rawHtml || '').trim();
    if (!sourceHtml) {
      return '';
    }

    let doc;
    try {
      const parser = new DOMParser();
      doc = parser.parseFromString(`<body>${sourceHtml}</body>`, 'text/html');
    } catch {
      return sourceHtml;
    }

    const body = doc.body;
    if (!body) {
      return sourceHtml;
    }

    body.querySelectorAll('script,style,iframe,meta,link,noscript').forEach((node) => node.remove());
    body.querySelectorAll('.feishu-unsupported').forEach((node) => node.remove());

    body.querySelectorAll('*').forEach((node) => {
      [...node.attributes].forEach((attribute) => {
        const name = String(attribute.name || '').toLowerCase();
        if (name.startsWith('on') || name === 'contenteditable') {
          node.removeAttribute(attribute.name);
          return;
        }

        if (name.startsWith('data-feishu-')) {
          node.removeAttribute(attribute.name);
        }
      });
    });

    body.querySelectorAll('a[href]').forEach((link) => {
      const href = coerceSafeUrl(link.getAttribute('href') || '');
      if (!href) {
        link.replaceWith(doc.createTextNode(normalizeText(link.textContent)));
        return;
      }
      link.setAttribute('href', href);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
    });

    body.querySelectorAll('.feishu-grid').forEach((grid) => {
      const fragment = doc.createDocumentFragment();
      [...grid.querySelectorAll('.feishu-grid-col')].forEach((column) => {
        while (column.firstChild) {
          fragment.appendChild(column.firstChild);
        }
      });
      grid.replaceWith(fragment);
    });

    body.querySelectorAll('figure').forEach((figure) => {
      const img = figure.querySelector('img');
      if (!img) {
        return;
      }

      normalizeImageNode(img, figure);

      const imageParagraph = doc.createElement('p');
      imageParagraph.style.textAlign = resolveTextAlign(figure, img) || 'center';
      imageParagraph.appendChild(img.cloneNode(true));

      const captionText = normalizeText(figure.querySelector('figcaption')?.textContent || '');
      const fragment = doc.createDocumentFragment();
      fragment.appendChild(imageParagraph);

      if (captionText) {
        const captionParagraph = doc.createElement('p');
        captionParagraph.style.textAlign = imageParagraph.style.textAlign || 'center';
        captionParagraph.innerHTML = `<span style="color: #7f7f7f;"><em>${escapeHtml(captionText)}</em></span>`;
        fragment.appendChild(captionParagraph);
      }

      figure.replaceWith(fragment);
    });

    body.querySelectorAll('img').forEach((img) => {
      normalizeImageNode(img);
      if (!img.closest('p,td,th,li')) {
        const wrapper = doc.createElement('p');
        wrapper.style.textAlign = 'center';
        img.replaceWith(wrapper);
        wrapper.appendChild(img);
      }
    });

    demoteHeadingsByOneLevel(body);

    body.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading, index) => {
      if (!normalizeText(heading.id)) {
        const plain = normalizeText(heading.textContent)
          .toLowerCase()
          .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
          .replace(/^_+|_+$/g, '');
        heading.id = `mctoc_${plain || index + 1}`;
      }
      if (!heading.style.textAlign) {
        heading.style.textAlign = 'justify';
      }
    });

    body.querySelectorAll('p,li,blockquote').forEach((node) => {
      const text = normalizeText(node.textContent || '');
      const hasOnlyBreak = node.childNodes.length === 1 && node.firstChild?.nodeName === 'BR';
      if (!text && !hasOnlyBreak) {
        return;
      }

      if (!node.style.textAlign) {
        node.style.textAlign = 'justify';
      }

      if (node.tagName === 'BLOCKQUOTE') {
        node.style.borderLeft = '3px solid #c9d3e4';
        node.style.paddingLeft = '12px';
      }
    });

    body.querySelectorAll('table').forEach((table) => {
      table.style.borderCollapse = 'collapse';
      if (!table.style.width) {
        table.style.width = '100%';
      }

      if (![...table.classList].some((name) => name.startsWith('table-cell-'))) {
        table.classList.add('table-cell-default-padding');
      }

      table.querySelectorAll('th,td').forEach((cell) => {
        if (!cell.style.border) {
          cell.style.border = '1px solid #cccccc';
        }
      });
    });

    body.querySelectorAll('section').forEach((section) => {
      if (!normalizeText(section.textContent) && section.querySelectorAll('img,table,video,audio').length === 0) {
        section.remove();
      }
    });

    return body.innerHTML.trim();
  };

  const resolveTextAlign = (...nodes) => {
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const alignStyle = normalizeText(node.style.textAlign || '').toLowerCase();
      if (alignStyle && ['left', 'center', 'right', 'justify'].includes(alignStyle)) {
        return alignStyle;
      }
      const alignAttr = normalizeText(node.getAttribute('align') || '').toLowerCase();
      if (alignAttr && ['left', 'center', 'right', 'justify'].includes(alignAttr)) {
        return alignAttr;
      }
    }
    return '';
  };

  const normalizeImageNode = (img, contextNode = null) => {
    if (!(img instanceof HTMLImageElement)) {
      return;
    }

    const src = coerceSafeUrl(
      img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || ''
    );
    if (src) {
      img.setAttribute('src', src);
    }

    const align = resolveTextAlign(contextNode, img);
    img.style.display = 'block';
    img.style.height = 'auto';
    img.style.maxWidth = '100%';

    if (align === 'left') {
      img.style.marginLeft = '0';
      img.style.marginRight = 'auto';
    } else if (align === 'right') {
      img.style.marginLeft = 'auto';
      img.style.marginRight = '0';
    } else {
      img.style.marginLeft = 'auto';
      img.style.marginRight = 'auto';
    }

    const widthAttr = Number(img.getAttribute('width') || 0);
    if (!widthAttr || widthAttr > 680) {
      img.setAttribute('width', '600');
    }

    img.removeAttribute('loading');
    img.removeAttribute('data-feishu-token');
    img.removeAttribute('data-feishu-block-id');
  };

  const clickDialogConfirm = (dialogRoot) => {
    const fromSelector = queryVisible(selectors.essayConfirmButtonCandidates || []);
    if (fromSelector) {
      return clickLikeUser(fromSelector);
    }

    const btn = findButtonByText(['确认', '确定'], dialogRoot || document);
    return clickLikeUser(btn);
  };

  const isLoginPage = () => {
    const href = String(location.href || '');
    if (/#\/login(?:\?|$)/.test(href)) {
      return true;
    }

    const hasLoginInput = Boolean(queryVisible(selectors.loginInputs || []));
    const hasLoginAction = Boolean(findButtonByText(['登录', '验证码登录', '立即登录']));
    const hasEditorSignals = Boolean(findTitleInput() || queryVisible(selectors.publishButtonCandidates || []));
    return hasLoginInput && hasLoginAction && !hasEditorSignals;
  };

  if (isLoginPage()) {
    return {
      ok: false,
      code: 'LOGIN_REQUIRED',
      error: 'FoodTalks 需要登录，请完成登录后继续'
    };
  }

  if (!location.href.includes('/#/radar/news/publish')) {
    location.href = 'https://admin-we.foodtalks.cn/#/radar/news/publish';
    await sleep(1800);
  }

  if (isLoginPage()) {
    return {
      ok: false,
      code: 'LOGIN_REQUIRED',
      error: 'FoodTalks 需要登录，请完成登录后继续'
    };
  }

  const pageReady = await waitUntil(() => {
    const titleInput = findTitleInput();
    const publishButton = queryVisible(selectors.publishButtonCandidates || []);
    const contentSignals = Boolean(
      findSourceCodeButton() ||
      getTinymceEditor() ||
      queryVisible(selectors.editorIframeCandidates || []) ||
      queryVisible(selectors.editorContentEditableCandidates || []) ||
      findFormItemByLabel(selectors.contentLabelKeywords || ['内容'])
    );
    return Boolean(publishButton && (titleInput || contentSignals));
  }, payload.pageReadyTimeoutMs || PAGE_READY_TIMEOUT_MS);

  if (!pageReady) {
    return {
      ok: false,
      error: 'FoodTalks 发布页初始化超时'
    };
  }

  let importerUsed = false;
  let importerSucceeded = false;
  let sourceCodeModeUsed = false;
  let sourceCodeModeSucceeded = false;

  const sourceUrl = String(payload.sourceUrl || payload.url || '').trim();
  const preferImporter = false;

  if (preferImporter && sourceUrl && isWechatUrl(sourceUrl)) {
    importerUsed = true;

    const essayButton =
      queryVisible(selectors.essayButtonCandidates || []) || findButtonByText(['公众号文章采集', '文章采集']);

    if (essayButton && clickLikeUser(essayButton)) {
      const dialog = await waitUntil(
        () => queryVisible(selectors.essayDialogCandidates || []),
        8_000,
        200
      );

      if (dialog) {
        const urlInput =
          queryVisible(selectors.essayInputCandidates || []) ||
          dialog.querySelector('input, textarea');

        if (urlInput && setNativeValue(urlInput, sourceUrl)) {
          const confirmClicked = clickDialogConfirm(dialog);
          if (confirmClicked) {
            const imported = await waitUntil(
              () => {
                const titleFilled = normalizeText(findTitleInput()?.value || '').length > 0;
                const contentLength = getEditorTextLength();
                return titleFilled || contentLength > 40;
              },
              payload.importWaitTimeoutMs || IMPORT_WAIT_TIMEOUT_MS,
              600
            );

            importerSucceeded = Boolean(imported);
            if (!importerSucceeded) {
              warnings.push('公众号采集已触发，但等待结果超时，已回退到手动填充');
            }
          } else {
            warnings.push('公众号采集弹窗确认按钮点击失败，已回退到手动填充');
          }
        } else {
          warnings.push('公众号采集输入框不可用，已回退到手动填充');
        }
      } else {
        warnings.push('未检测到公众号采集弹窗，已回退到手动填充');
      }
    } else {
      warnings.push('未检测到公众号采集按钮，已回退到手动填充');
    }
  }

  const titleInput = findTitleInput();
  const fallbackTitle = String(payload.title || '').trim();

  if (titleInput && fallbackTitle) {
    const currentTitle = normalizeText(titleInput.value || '');
    if (!currentTitle || !importerSucceeded) {
      setNativeValue(titleInput, fallbackTitle);
    }
  }

  const shouldFillContent = !importerSucceeded || getEditorTextLength() < 30;
  if (shouldFillContent) {
    const html = String(payload.contentHtml || '').trim();
    const text = String(payload.textPlain || '').trim();
    const fallbackHtml = html || (text ? `<p>${text.replace(/\n/g, '</p><p>')}</p>` : '');

    if (fallbackHtml) {
      sourceCodeModeUsed = true;
      sourceCodeModeSucceeded = await setEditorContentBySourceCode(fallbackHtml);

      if (!sourceCodeModeSucceeded && !setEditorContent(fallbackHtml)) {
        warnings.push('正文编辑器未定位成功，请手动粘贴正文');
      }
    }
  }

  const action = payload.publishAction === 'publish' ? 'publish' : payload.publishAction === 'none' ? 'none' : 'draft';
  let actionTriggered = false;

  if (action === 'draft') {
    const draftButton =
      queryVisible(selectors.draftButtonCandidates || []) || findButtonByText(['保存草稿', '草稿']);
    actionTriggered = clickLikeUser(draftButton);
    if (!actionTriggered) {
      warnings.push('未点击到“保存草稿”按钮，请手动保存');
    }
  }

  if (action === 'publish') {
    const publishButton =
      queryVisible(selectors.publishButtonCandidates || []) || findButtonByText(['发布', '保存并发布']);
    actionTriggered = clickLikeUser(publishButton);
    if (!actionTriggered) {
      warnings.push('未点击到“发布”按钮，请手动发布');
    }
  }

  return {
    ok: true,
    warnings,
    detail: {
      importerUsed,
      importerSucceeded,
      sourceCodeModeUsed,
      sourceCodeModeSucceeded,
      action,
      actionTriggered,
      titleLength: normalizeText(findTitleInput()?.value || '').length,
      contentLength: getEditorTextLength(),
      currentUrl: location.href
    }
  };
}
