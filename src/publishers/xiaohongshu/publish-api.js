import { PLATFORM_SPECS } from '../shared/platform-specs.js';

function fillXiaohongshuInPage(payload, spec) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const hasLoginChallenge = () => {
    const href = location.href.toLowerCase();
    if (href.includes('/login') || href.includes('/signin') || href.includes('/passport')) return true;
    const passwordInput = document.querySelector('input[type="password"], input[name="password"]');
    return Boolean(passwordInput && isVisible(passwordInput));
  };

  const findFirstVisible = (selectors = []) => {
    for (const selector of selectors) {
      const hit = [...document.querySelectorAll(selector)].find((node) => isVisible(node));
      if (hit) return hit;
    }
    return null;
  };

  const findFileInput = (selectors = []) => {
    for (const selector of selectors) {
      const hit = [...document.querySelectorAll(selector)].find((node) => {
        return node instanceof HTMLInputElement && node.type === 'file' && !node.disabled;
      });
      if (hit) return hit;
    }
    return null;
  };

  const clickLikeUser = (node) => {
    if (!node) return false;
    try {
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
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
    if (!input) return false;
    try {
      input.focus();
      const descriptor = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value');
      if (descriptor?.set) descriptor.set.call(input, value);
      else input.value = value;

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const sanitizeContent = (html) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html || '';
    wrapper.querySelectorAll('script,style,iframe,link,meta,noscript').forEach((node) => node.remove());

    const lines = [];
    wrapper.querySelectorAll('h1,h2,h3,h4,p,li,blockquote').forEach((node) => {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    });

    if (!lines.length) {
      const fallback = (wrapper.textContent || '').replace(/\s+/g, ' ').trim();
      if (fallback) lines.push(fallback);
    }

    return lines.join('\n\n').trim();
  };

  const setEditorText = (editor, text) => {
    try {
      editor.focus();

      if (editor.classList.contains('ql-editor')) {
        editor.innerHTML = '';
      } else {
        editor.textContent = '';
      }

      const lines = (text || '')
        .split(/\n{2,}/)
        .map((item) => item.trim())
        .filter(Boolean);

      if (!lines.length) {
        editor.textContent = text || '';
      } else {
        for (const line of lines) {
          const p = document.createElement('p');
          p.textContent = line;
          editor.appendChild(p);
        }
      }

      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text || '' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const dataUrlToFile = (image, index) => {
    const dataUrl = image?.dataUrl || '';
    if (!dataUrl.startsWith('data:')) return null;

    const splitIndex = dataUrl.indexOf(',');
    if (splitIndex < 0) return null;

    const meta = dataUrl.slice(0, splitIndex);
    const base64 = dataUrl.slice(splitIndex + 1);
    const mimeMatch = /data:([^;]+);base64/i.exec(meta);
    const mimeType = image?.type || mimeMatch?.[1] || 'image/jpeg';

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('gif') ? 'gif' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const fileName = image?.name || `xhs-${Date.now()}-${index}.${ext}`;
    return new File([bytes], fileName, { type: mimeType });
  };

  const countEditorImages = () => {
    const selectors = spec.editorImageSelectors || [];
    for (const selector of selectors) {
      const size = document.querySelectorAll(selector).length;
      if (size > 0) return size;
    }
    return 0;
  };

  const uploadByInput = async (images) => {
    const fileInput = findFileInput(spec.imageInputSelectors);
    if (!fileInput) return { ok: false, uploadedCount: 0, reason: 'missing-file-input' };

    const files = images
      .map((image, index) => dataUrlToFile(image, index))
      .filter(Boolean)
      .slice(0, spec.maxImages || 9);

    if (!files.length) return { ok: true, uploadedCount: 0 };

    const beforeCount = countEditorImages();

    try {
      const dt = new DataTransfer();
      files.forEach((file) => dt.items.add(file));

      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      if (descriptor?.set) descriptor.set.call(fileInput, dt.files);
      else fileInput.files = dt.files;

      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      await sleep(2200 + files.length * 300);

      const afterCount = countEditorImages();
      const uploaded = Math.max(0, afterCount - beforeCount);
      return { ok: true, uploadedCount: uploaded > 0 ? uploaded : files.length };
    } catch (error) {
      return {
        ok: false,
        uploadedCount: 0,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  };

  const pasteImageFile = async (editor, file) => {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);

      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dt });
      editor.dispatchEvent(event);
      await sleep(700);
      return true;
    } catch {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(dropEvent, 'dataTransfer', { value: dt });
        editor.dispatchEvent(dropEvent);
        await sleep(800);
        return true;
      } catch {
        return false;
      }
    }
  };

  const uploadByPaste = async (editor, images) => {
    let success = 0;
    const files = images
      .map((image, index) => dataUrlToFile(image, index))
      .filter(Boolean)
      .slice(0, spec.maxImages || 9);

    for (const file of files) {
      const ok = await pasteImageFile(editor, file);
      if (ok) success += 1;
    }

    return success;
  };

  return (async () => {
    if (hasLoginChallenge()) {
      return { ok: false, error: '检测到当前平台未登录，请先登录小红书后重试' };
    }

    let titleNode = findFirstVisible(spec.titleSelectors);
    let editorNode = findFirstVisible(spec.editorSelectors);

    if (!titleNode || !editorNode) {
      const createButton = [...document.querySelectorAll('button, [role="button"], .d-button, .custom-button')]
        .filter((node) => isVisible(node))
        .find((node) => {
          const content = (node.textContent || '').replace(/\s+/g, '');
          return (spec.createButtonTexts || []).some((text) => content.includes(text));
        });

      if (createButton) {
        clickLikeUser(createButton);
        await sleep(1300);
      }

      titleNode = findFirstVisible(spec.titleSelectors);
      editorNode = findFirstVisible(spec.editorSelectors);
    }

    if (!titleNode || !editorNode) {
      return { ok: false, error: '未定位到小红书标题或正文编辑器' };
    }

    const titleOk = setNativeValue(titleNode, (payload.title || '').trim());
    const textContent = sanitizeContent(payload.contentHtml || payload.textPlain || '');
    const contentOk = setEditorText(editorNode, textContent || payload.textPlain || '');

    const preparedImages = Array.isArray(payload.preparedImages) ? payload.preparedImages : [];

    let uploadedCount = 0;
    let uploadMode = 'none';

    if (preparedImages.length > 0) {
      const inputResult = await uploadByInput(preparedImages);
      if (inputResult.ok && inputResult.uploadedCount > 0) {
        uploadedCount = inputResult.uploadedCount;
        uploadMode = 'file-input';
      } else {
        uploadedCount = await uploadByPaste(editorNode, preparedImages);
        uploadMode = uploadedCount > 0 ? 'paste' : `failed:${inputResult.reason || 'unknown'}`;
      }
    }

    const warnings = [];
    if (!titleOk) warnings.push('小红书标题填充失败');
    if (!contentOk) warnings.push('小红书正文填充失败');

    const expectedCount = preparedImages.length;
    if (expectedCount > uploadedCount) {
      warnings.push(`图片自动导入 ${uploadedCount}/${expectedCount}，剩余请手动上传`);
    }

    return {
      ok: titleOk && contentOk,
      warnings,
      detail: {
        titleOk,
        contentOk,
        uploadMode,
        uploadedImageCount: uploadedCount,
        totalImageCount: expectedCount,
        finalUrl: location.href
      }
    };
  })();
}

export async function publishXiaohongshu({ tabId, payload, runtime }) {
  const executeResult = await runtime.withTimeout(
    runtime.executeInTab({
      tabId,
      func: fillXiaohongshuInPage,
      args: [payload, PLATFORM_SPECS.xiaohongshu],
      timeoutMs: 120_000
    }),
    125_000,
    '小红书自动填充超时'
  );

  const detail = executeResult?.[0]?.result;
  if (!detail?.ok) {
    return {
      ok: false,
      error: detail?.error || '小红书自动填充失败'
    };
  }

  const preparation = payload.imagePreparation || {};
  const warnings = [...(detail.warnings ?? [])];
  if (preparation.failedCount > 0) {
    warnings.push(`图片预处理失败 ${preparation.failedCount} 张，建议手动补图`);
  }

  return {
    ok: true,
    warnings,
    detail: {
      ...(detail.detail || detail),
      imagePreparation: preparation
    }
  };
}
