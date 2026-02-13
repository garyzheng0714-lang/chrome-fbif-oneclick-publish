function fillZhihuByDraftApi(payload) {
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const hasLoginChallenge = () => {
    const href = location.href.toLowerCase();
    if (href.includes('login') || href.includes('signin') || href.includes('passport')) return true;
    const passwordInput = document.querySelector(
      'input[type="password"], input[name="password"], input[autocomplete="current-password"]'
    );
    return Boolean(passwordInput && isVisible(passwordInput));
  };

  const sanitizeHtml = (html) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html || '';

    wrapper.querySelectorAll('script,style,iframe,link,meta,noscript').forEach((node) => node.remove());

    wrapper.querySelectorAll('*').forEach((node) => {
      const tag = node.tagName?.toLowerCase();
      [...node.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        const keep =
          (tag === 'a' && (name === 'href' || name === 'target' || name === 'rel')) ||
          (tag === 'img' && (name === 'src' || name === 'alt'));
        if (!keep) {
          node.removeAttribute(attr.name);
        }
      });

      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        if (!href) node.remove();
      }
    });

    return wrapper;
  };

  const replaceImagesByZhihuUpload = async (wrapper) => {
    const imgs = [...wrapper.querySelectorAll('img[src]')];
    const srcSet = [...new Set(imgs.map((img) => img.getAttribute('src')).filter(Boolean))];
    const external = srcSet.filter((src) => !/zhimg\.com|pic-private\.zhihu\.com/i.test(src));

    const map = new Map();
    for (const src of external.slice(0, 30)) {
      try {
        const body = new URLSearchParams({ url: src, source: 'article' });
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
          continue;
        }

        const data = await response.json().catch(() => ({}));
        if (typeof data?.src === 'string' && data.src) {
          map.set(src, data.src);
        }
      } catch {
        // keep original when upload failed
      }
    }

    imgs.forEach((img) => {
      const src = img.getAttribute('src') || '';
      const uploaded = map.get(src);
      if (uploaded) img.setAttribute('src', uploaded);

      const parentTag = img.parentElement?.tagName?.toLowerCase();
      if (parentTag !== 'figure') {
        const figure = document.createElement('figure');
        img.replaceWith(figure);
        figure.appendChild(img);
      }
    });

    return {
      uploadedCount: map.size,
      imageCount: imgs.length
    };
  };

  const createOrUpdateDraft = async ({ title, html }) => {
    const createResponse = await fetch('https://zhuanlan.zhihu.com/api/articles/drafts', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-requested-with': 'fetch'
      },
      body: JSON.stringify({
        title,
        content: '',
        delta_time: 0
      })
    });

    const createText = await createResponse.text();
    const createData = (() => {
      try {
        return JSON.parse(createText);
      } catch {
        return null;
      }
    })();

    if (!createResponse.ok || !createData?.id) {
      throw new Error(`创建知乎草稿失败(${createResponse.status})`);
    }

    const draftId = createData.id;

    const patchResponse = await fetch(`https://zhuanlan.zhihu.com/api/articles/${draftId}/draft`, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-requested-with': 'fetch'
      },
      body: JSON.stringify({
        title,
        content: html
      })
    });

    if (!patchResponse.ok) {
      throw new Error(`更新知乎草稿失败(${patchResponse.status})`);
    }

    return {
      draftId,
      draftUrl: `https://zhuanlan.zhihu.com/p/${draftId}/edit`
    };
  };

  return (async () => {
    if (hasLoginChallenge()) {
      return { ok: false, error: '检测到当前平台未登录，请先登录知乎后重试' };
    }

    const title = (payload.title || '').trim();
    if (!title) {
      return { ok: false, error: '知乎发布标题不能为空' };
    }

    const wrapper = sanitizeHtml(payload.contentHtml || '');
    const imageResult = await replaceImagesByZhihuUpload(wrapper);

    if (!wrapper.textContent?.trim() && wrapper.querySelectorAll('img').length === 0) {
      return { ok: false, error: '知乎正文为空，无法生成草稿' };
    }

    const { draftId, draftUrl } = await createOrUpdateDraft({ title, html: wrapper.innerHTML.trim() });

    return {
      ok: true,
      warnings: [
        imageResult.uploadedCount > 0
          ? `已上传 ${imageResult.uploadedCount}/${imageResult.imageCount} 张图片到知乎图床`
          : '未检测到可上传图片或图片已为知乎图床地址'
      ],
      draftId,
      draftUrl,
      detail: {
        draftId,
        draftUrl,
        uploadedImageCount: imageResult.uploadedCount,
        totalImageCount: imageResult.imageCount
      }
    };
  })();
}

export async function publishZhihu({ tabId, payload, runtime }) {
  const executeResult = await runtime.withTimeout(
    runtime.executeInTab({
      tabId,
      func: fillZhihuByDraftApi,
      args: [payload],
      timeoutMs: 90_000
    }),
    95_000,
    '知乎草稿创建超时'
  );

  const detail = executeResult?.[0]?.result;
  if (!detail?.ok) {
    return {
      ok: false,
      error: detail?.error || '知乎发布失败'
    };
  }

  if (detail?.draftUrl) {
    await chrome.tabs.update(tabId, { url: detail.draftUrl }).catch(() => undefined);
  }

  return {
    ok: true,
    warnings: detail.warnings ?? [],
    detail
  };
}
