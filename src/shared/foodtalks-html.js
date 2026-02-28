import { demoteHeadingsByOneLevel } from '../publishers/shared/heading-normalizer.js';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeUrlForPublish(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return `https:${raw}`;
  if (/^(https?:|blob:)/i.test(raw)) return raw;
  return '';
}

function resolveTextAlignForPublish(...nodes) {
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }

    const styleAlign = normalizeText(node.style.textAlign || '').toLowerCase();
    if (styleAlign && ['left', 'center', 'right', 'justify'].includes(styleAlign)) {
      return styleAlign;
    }

    const attrAlign = normalizeText(node.getAttribute('align') || '').toLowerCase();
    if (attrAlign && ['left', 'center', 'right', 'justify'].includes(attrAlign)) {
      return attrAlign;
    }
  }

  return '';
}

export function normalizeImageNodeForPublish(img, contextNode = null) {
  if (!(img instanceof HTMLImageElement)) {
    return;
  }

  const src = normalizeUrlForPublish(
    img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || ''
  );
  if (src) {
    img.setAttribute('src', src);
  } else {
    img.removeAttribute('src');
  }

  const align = resolveTextAlignForPublish(contextNode, img);
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
  img.removeAttribute('decoding');
  img.removeAttribute('data-feishu-token');
  img.removeAttribute('data-feishu-block-id');
}

function extractCaptionLines(container) {
  if (!(container instanceof HTMLElement)) {
    return [];
  }

  const lines = [...container.querySelectorAll('p')]
    .map((node) => normalizeText(node.textContent || ''))
    .filter(Boolean);
  if (lines.length > 0) {
    return lines.slice(0, 3);
  }

  const fallback = normalizeText(container.textContent || '');
  return fallback ? [fallback] : [];
}

function isLikelyCaptionParagraph(node) {
  if (!(node instanceof HTMLParagraphElement)) {
    return false;
  }
  const text = normalizeText(node.textContent || '');
  if (!text || text.length > 90) {
    return false;
  }
  if (/^[\u4e00-\u9fa5a-z0-9]{40,}[。！？!?]$/i.test(text)) {
    return false;
  }

  const align = resolveTextAlignForPublish(node);
  if (align === 'center') {
    return true;
  }
  if (/^(图|图片|photo|来源|source|caption)[:：\s]/i.test(text)) {
    return true;
  }
  return false;
}

function collectFollowingCaptionLines(anchorNode) {
  const lines = [];
  let cursor = anchorNode?.nextElementSibling || null;

  while (cursor && lines.length < 3) {
    if (!isLikelyCaptionParagraph(cursor)) {
      break;
    }

    const line = normalizeText(cursor.textContent || '');
    if (line) {
      lines.push(line);
    }

    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }

  return lines;
}

function appendCaptionLinesToFigure(figure, lines, doc) {
  if (!(figure instanceof HTMLElement) || !Array.isArray(lines) || lines.length === 0) {
    return;
  }

  const figcaption = doc.createElement('figcaption');
  figcaption.style.textAlign = 'center';
  figcaption.style.fontSize = '12px';
  figcaption.style.color = '#5f6773';
  figcaption.textContent = lines.join(' ');
  figure.appendChild(figcaption);
}

function normalizeFigureNodeForPublish(figure, doc) {
  if (!(figure instanceof HTMLElement)) {
    return;
  }

  const img = figure.querySelector('img');
  if (!(img instanceof HTMLImageElement)) {
    return;
  }

  normalizeImageNodeForPublish(img, figure);
  const captionLines = [];
  const figcaption = figure.querySelector('figcaption');
  if (figcaption) {
    captionLines.push(...extractCaptionLines(figcaption));
    figcaption.remove();
  }
  captionLines.push(...collectFollowingCaptionLines(figure));

  while (figure.firstChild) {
    figure.removeChild(figure.firstChild);
  }

  figure.className = 'image';
  figure.removeAttribute('style');
  figure.appendChild(img);
  appendCaptionLinesToFigure(figure, captionLines, doc);
}

export function validatePublishHtmlImages(html) {
  if (typeof DOMParser !== 'function') {
    return { totalCount: 0, invalidCount: 0 };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${String(html || '')}</body>`, 'text/html');
  const images = [...doc.body.querySelectorAll('img')];

  let invalidCount = 0;
  images.forEach((img) => {
    const src = String(img.getAttribute('src') || '').trim();
    if (!src || /^blob:/i.test(src)) {
      invalidCount += 1;
    }
  });

  return {
    totalCount: images.length,
    invalidCount
  };
}

export function buildFoodtalksPasteHtml(rawHtml) {
  const sourceHtml = String(rawHtml || '').trim();
  if (!sourceHtml || typeof DOMParser !== 'function') {
    return sourceHtml;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${sourceHtml}</body>`, 'text/html');
  const body = doc.body;
  if (!body) {
    return sourceHtml;
  }

  body.querySelectorAll('script,style,iframe,meta,link,noscript,form,input,textarea,button').forEach((node) => {
    node.remove();
  });
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

  body.querySelectorAll('.feishu-grid').forEach((grid) => {
    const fragment = doc.createDocumentFragment();
    [...grid.querySelectorAll('.feishu-grid-col')].forEach((column) => {
      while (column.firstChild) {
        fragment.appendChild(column.firstChild);
      }
    });
    grid.replaceWith(fragment);
  });

  body.querySelectorAll('a[href]').forEach((anchor) => {
    const href = normalizeUrlForPublish(anchor.getAttribute('href') || '');
    if (!href) {
      anchor.replaceWith(doc.createTextNode(normalizeText(anchor.textContent || '')));
      return;
    }
    anchor.setAttribute('href', href);
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener');
  });

  body.querySelectorAll('figure').forEach((figure) => {
    normalizeFigureNodeForPublish(figure, doc);
  });

  const standaloneImages = [...body.querySelectorAll('img')].filter((img) => !img.closest('figure'));
  standaloneImages.forEach((img) => {
    normalizeImageNodeForPublish(img);
    if (img.closest('td,th,li')) {
      return;
    }

    const parentParagraph = img.parentElement instanceof HTMLParagraphElement ? img.parentElement : null;
    const wrapsOnlyImage =
      Boolean(parentParagraph) &&
      parentParagraph.querySelectorAll('img').length === 1 &&
      normalizeText(parentParagraph.textContent || '') === '';
    const sourceNode = wrapsOnlyImage ? parentParagraph : img;
    const captionLines = collectFollowingCaptionLines(sourceNode);

    if (captionLines.length > 0) {
      const figure = doc.createElement('figure');
      figure.className = 'image';
      sourceNode.replaceWith(figure);
      figure.appendChild(img);
      appendCaptionLinesToFigure(figure, captionLines, doc);
      return;
    }

    if (!img.closest('p')) {
      const paragraph = doc.createElement('p');
      paragraph.style.textAlign = 'center';
      img.replaceWith(paragraph);
      paragraph.appendChild(img);
    }
  });

  demoteHeadingsByOneLevel(body);

  body.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading, index) => {
    if (!normalizeText(heading.id)) {
      const idBase = normalizeText(heading.textContent)
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
        .replace(/^_+|_+$/g, '');
      heading.id = `mctoc_${idBase || index + 1}`;
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
      node.style.margin = '12px 0';
    }
  });

  body.querySelectorAll('table').forEach((table) => {
    table.style.borderCollapse = 'collapse';
    table.style.width = table.style.width || '100%';

    table.querySelectorAll('th,td').forEach((cell) => {
      if (!cell.style.border) {
        cell.style.border = '1px solid #cccccc';
      }
      if (!cell.style.textAlign) {
        const align = normalizeText(cell.getAttribute('align') || '').toLowerCase();
        cell.style.textAlign = align && ['left', 'center', 'right', 'justify'].includes(align) ? align : 'left';
      }
      if (!cell.style.verticalAlign) {
        const valign = normalizeText(cell.getAttribute('valign') || '').toLowerCase();
        cell.style.verticalAlign = valign && ['top', 'middle', 'bottom'].includes(valign) ? valign : 'middle';
      }
      if (!cell.style.padding) {
        cell.style.padding = '8px 10px';
      }
    });
  });

  return body.innerHTML.trim();
}
