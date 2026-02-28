function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const WECHAT_IMAGE_CAPTION_STYLE =
  'text-align:center;line-height:1.6;margin:8px 0 14px;font-size:12px;color:#8c8c8c;padding:0;background:transparent;border:0;border-radius:0;box-shadow:none;';

function normalizeUrlForWechat(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return `https:${raw}`;
  if (/^(https?:|blob:)/i.test(raw)) return raw;
  return '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractCaptionLinesFromHtml(rawHtml) {
  const normalized = String(rawHtml || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ');

  return normalized
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function buildCaptionParagraphHtml(rawHtml) {
  const lines = extractCaptionLinesFromHtml(rawHtml);
  if (!lines.length) {
    return '';
  }

  const content = lines.map((line) => escapeHtml(line)).join('<br />');
  return `<p data-wechat-caption="1">${content}</p>`;
}

function removeUnsupportedTags(sourceHtml) {
  return sourceHtml.replace(/<\/?(script|style|iframe|meta|link|noscript|form|input|textarea|button)[^>]*>/gi, '');
}

function sanitizeHtmlWithRegex(sourceHtml) {
  const removedUnsupported = removeUnsupportedTags(sourceHtml);
  const withoutEvents = removedUnsupported
    .replace(/\son[a-z-]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\scontenteditable\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\sdata-feishu-[a-z0-9_-]*\s*=\s*(['"]).*?\1/gi, '');
  const normalizedCaptions = withoutEvents.replace(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi, (_raw, inner) =>
    buildCaptionParagraphHtml(inner)
  );

  return normalizedCaptions
    .replace(/<h([1-6])([^>]*)>/gi, '<h$1$2 style="line-height:1.5;margin:22px 0 12px;font-weight:600;">')
    .replace(/<p([^>]*)>/gi, (_raw, attrs) => {
      const rawAttrs = String(attrs || '');
      const isCaption = /\sdata-wechat-caption\s*=\s*(['"])1\1/i.test(rawAttrs);
      const withoutFlag = rawAttrs.replace(/\sdata-wechat-caption\s*=\s*(['"])1\1/gi, '');
      const cleanedAttrs = withoutFlag.replace(/\sstyle\s*=\s*(['"]).*?\1/gi, '').trim();
      const mergedAttrs = cleanedAttrs ? ` ${cleanedAttrs}` : '';
      return isCaption
        ? `<p${mergedAttrs} style="${WECHAT_IMAGE_CAPTION_STYLE}">`
        : `<p${mergedAttrs} style="line-height:1.75;margin:0 0 14px;">`;
    })
    .replace(/<(ul|ol)([^>]*)>/gi, '<$1$2 style="margin:0 0 14px 1.4em;padding:0;">')
    .replace(/<li([^>]*)>/gi, '<li$1 style="margin:0 0 8px;">')
    .replace(
      /<blockquote([^>]*)>/gi,
      '<blockquote$1 style="margin:0 0 14px;padding:8px 12px;border-left:3px solid #d0d7e2;color:#3f4752;background:#f7f8fa;">'
    )
    .replace(/<img([^>]*)>/gi, (raw, attrs) => {
      const srcMatch = attrs.match(/\ssrc\s*=\s*(['"])(.*?)\1/i);
      const srcValue = normalizeUrlForWechat(srcMatch?.[2] || '');
      const nextAttrs = attrs
        .replace(/\sloading\s*=\s*(['"]).*?\1/gi, '')
        .replace(/\sdecoding\s*=\s*(['"]).*?\1/gi, '')
        .replace(/\sdata-feishu-[a-z0-9_-]*\s*=\s*(['"]).*?\1/gi, '')
        .replace(/\sstyle\s*=\s*(['"]).*?\1/gi, '')
        .trim();
      const safeAttrs = srcValue
        ? ` src="${srcValue}"${nextAttrs ? ` ${nextAttrs.replace(/\ssrc\s*=\s*(['"]).*?\1/gi, '').trim()}` : ''}`
        : `${nextAttrs ? ` ${nextAttrs.replace(/\ssrc\s*=\s*(['"]).*?\1/gi, '').trim()}` : ''}`;
      return `<img${safeAttrs} style="display:block;max-width:100%;height:auto;margin:0 auto;" />`;
    });
}

function sanitizeHtmlWithDom(sourceHtml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${sourceHtml}</body>`, 'text/html');
  const body = doc.body;
  if (!body) {
    return sourceHtml;
  }

  body.querySelectorAll('script,style,iframe,meta,link,noscript,form,input,textarea,button').forEach((node) => {
    node.remove();
  });

  body.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = String(attribute.name || '').toLowerCase();
      if (name.startsWith('on') || name === 'contenteditable' || name.startsWith('data-feishu-')) {
        node.removeAttribute(attribute.name);
      }
    });
  });

  body.querySelectorAll('p').forEach((paragraph) => {
    paragraph.style.lineHeight = '1.75';
    paragraph.style.margin = '0 0 14px';
  });

  body.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => {
    heading.style.lineHeight = '1.5';
    heading.style.margin = '22px 0 12px';
    heading.style.fontWeight = '600';
  });

  body.querySelectorAll('ul,ol').forEach((list) => {
    list.style.margin = '0 0 14px 1.4em';
    list.style.padding = '0';
  });

  body.querySelectorAll('li').forEach((item) => {
    item.style.margin = '0 0 8px';
  });

  body.querySelectorAll('blockquote').forEach((quote) => {
    quote.style.margin = '0 0 14px';
    quote.style.padding = '8px 12px';
    quote.style.borderLeft = '3px solid #d0d7e2';
    quote.style.color = '#3f4752';
    quote.style.background = '#f7f8fa';
  });

  body.querySelectorAll('figure').forEach((figure) => {
    figure.style.margin = '0 0 14px';
    figure.style.padding = '0';
    figure.style.border = '0';
    figure.style.background = 'transparent';
  });

  body.querySelectorAll('figcaption').forEach((caption) => {
    const paragraphHtml = buildCaptionParagraphHtml(caption.innerHTML || caption.textContent || '');
    if (!paragraphHtml) {
      caption.remove();
      return;
    }

    const wrapper = doc.createElement('div');
    wrapper.innerHTML = paragraphHtml;
    const normalized = wrapper.querySelector('p');
    if (!normalized) {
      caption.remove();
      return;
    }
    normalized.style.cssText = WECHAT_IMAGE_CAPTION_STYLE;
    normalized.removeAttribute('data-wechat-caption');
    caption.replaceWith(normalized);
  });

  body.querySelectorAll('img').forEach((img) => {
    const src = normalizeUrlForWechat(
      img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || ''
    );
    if (src) {
      img.setAttribute('src', src);
    } else {
      img.removeAttribute('src');
    }

    img.style.display = 'block';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.margin = '0 auto';
    img.removeAttribute('loading');
    img.removeAttribute('decoding');
    img.removeAttribute('data-feishu-token');
    img.removeAttribute('data-feishu-block-id');
  });

  return body.innerHTML.trim();
}

export function sanitizeWechatPublishHtml(rawHtml) {
  const sourceHtml = String(rawHtml || '').trim();
  if (!sourceHtml) {
    return '';
  }

  if (typeof DOMParser === 'function') {
    return sanitizeHtmlWithDom(sourceHtml);
  }

  return sanitizeHtmlWithRegex(sourceHtml);
}

export function applyWechatTemplate(html, templateId = '', registry = {}) {
  const normalizedHtml = String(html || '').trim();
  if (!normalizedHtml) {
    return '';
  }

  const id = String(templateId || '').trim();
  if (!id) {
    return normalizedHtml;
  }

  const templates = registry && typeof registry === 'object' ? registry : {};
  const template = templates[id];
  if (!template || typeof template !== 'object') {
    return normalizedHtml;
  }

  const prefix = String(template.prefixHtml || '').trim();
  const suffix = String(template.suffixHtml || '').trim();
  if (!prefix && !suffix) {
    return normalizedHtml;
  }

  return [prefix, normalizedHtml, suffix].filter(Boolean).join('\n');
}

export function buildWechatPasteHtml(contentHtml, options = {}) {
  const sourceHtml = String(contentHtml || '').trim();
  if (!sourceHtml) {
    return '';
  }

  const sanitized = sanitizeWechatPublishHtml(sourceHtml);
  const templateId = String(options?.templateId || '').trim();
  const templateRegistry = options?.templateRegistry && typeof options.templateRegistry === 'object'
    ? options.templateRegistry
    : {};
  const withTemplate = applyWechatTemplate(sanitized, templateId, templateRegistry);

  return normalizeText(withTemplate) ? withTemplate : '';
}
