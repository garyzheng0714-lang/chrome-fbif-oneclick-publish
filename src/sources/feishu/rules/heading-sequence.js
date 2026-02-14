function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getHeadingLevelByBlockType(blockType) {
  const type = Number(blockType || 0);
  if (type >= 3 && type <= 8) {
    return type - 2;
  }
  return 0;
}

function hasHeadingSequencePrefix(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  return /^((\d+([.．]\d+)*)[.．、)\s]|[(（]?[一二三四五六七八九十百千万零〇]+[)）.．、]|[ivxlcdmIVXLCDM]+[.．、)\s]|[A-Za-z][.．、)\s])/u.test(
    normalized
  );
}

function parseNumericHeadingSequence(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^(\d+(?:[.．]\d+)*)(?:[.．、)\s]|$)/u);
  if (!matched?.[1]) {
    return null;
  }

  const parts = matched[1]
    .split(/[.．]/)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .slice(0, 6);

  return parts.length > 0 ? parts : null;
}

function ensureHeadingCounters(context) {
  if (!context || typeof context !== 'object') {
    return [0, 0, 0, 0, 0, 0];
  }

  if (!Array.isArray(context.headingCounters) || context.headingCounters.length !== 6) {
    context.headingCounters = [0, 0, 0, 0, 0, 0];
  }
  return context.headingCounters;
}

function syncHeadingCountersFromSequence(context, sequence) {
  const counters = ensureHeadingCounters(context);
  counters.fill(0);

  sequence.forEach((value, index) => {
    if (index >= counters.length) {
      return;
    }
    counters[index] = Number(value) || 0;
  });
}

function buildHeadingSequence(context, level) {
  const safeLevel = Math.max(1, Math.min(6, Number(level) || 1));
  const counters = ensureHeadingCounters(context);

  for (let index = 0; index < safeLevel - 1; index += 1) {
    if (counters[index] <= 0) {
      counters[index] = 1;
    }
  }

  counters[safeLevel - 1] += 1;
  for (let index = safeLevel; index < counters.length; index += 1) {
    counters[index] = 0;
  }

  return counters.slice(0, safeLevel).join('.');
}

export function applyHeadingSequenceRule({ blockType, plainText, renderedHtml, context }) {
  const level = getHeadingLevelByBlockType(blockType);
  const safeHtml = String(renderedHtml || '');
  const text = String(plainText || '');
  const normalizedText = normalizeText(text);

  if (!safeHtml || level <= 0 || !normalizedText) {
    return {
      html: safeHtml,
      plainText: text
    };
  }

  const numericSequence = parseNumericHeadingSequence(normalizedText);
  if (numericSequence) {
    syncHeadingCountersFromSequence(context, numericSequence);
    return {
      html: safeHtml,
      plainText: text
    };
  }

  if (hasHeadingSequencePrefix(normalizedText)) {
    return {
      html: safeHtml,
      plainText: text
    };
  }

  const generatedSequence = buildHeadingSequence(context, level);
  return {
    html: `<span class="feishu-heading-seq">${escapeHtml(generatedSequence)}</span> ${safeHtml}`,
    plainText: `${generatedSequence} ${text}`.trim()
  };
}
