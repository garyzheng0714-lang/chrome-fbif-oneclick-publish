const JSON_LIKE_PREFIX = /^[\[{"]/;
const MAX_JSON_PARSE_DEPTH = 2;
const MAX_TRAVERSE_DEPTH = 3;

const TITLE_PATHS = [
  ['title'],
  ['articleTitle'],
  ['docTitle'],
  ['meta', 'title']
];

const CONTENT_PATHS = [
  ['contentHtml'],
  ['wechatHtml'],
  ['html'],
  ['bodyHtml'],
  ['content'],
  ['body']
];

const TEMPLATE_PATHS = [['templateId'], ['meta', 'templateId']];
const CONTAINER_KEYS = ['payload', 'data', 'article', 'result', 'body', 'content', 'meta'];

function readPathString(source, path = []) {
  let cursor = source;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') {
      return '';
    }
    cursor = cursor[key];
  }
  return typeof cursor === 'string' ? cursor.trim() : '';
}

function tryParseJsonLike(value) {
  let current = typeof value === 'string' ? value.trim() : '';
  if (!current || !JSON_LIKE_PREFIX.test(current)) {
    return null;
  }

  for (let depth = 0; depth <= MAX_JSON_PARSE_DEPTH; depth += 1) {
    try {
      const parsed = JSON.parse(current);
      if (typeof parsed === 'string') {
        current = parsed.trim();
        if (!current || !JSON_LIKE_PREFIX.test(current)) {
          return null;
        }
        continue;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  return null;
}

function collectPayloadCandidates(rawPayload) {
  const candidates = [];
  const visited = new Set();

  function visit(value, depth) {
    if (depth > MAX_TRAVERSE_DEPTH || value == null) {
      return;
    }

    if (typeof value === 'string') {
      const parsed = tryParseJsonLike(value);
      if (parsed) {
        visit(parsed, depth + 1);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    if (visited.has(value)) {
      return;
    }
    visited.add(value);
    candidates.push(value);

    for (const key of CONTAINER_KEYS) {
      if (Object.hasOwn(value, key)) {
        visit(value[key], depth + 1);
      }
    }
  }

  visit(rawPayload, 0);
  return candidates;
}

function pickFirstString(candidates, paths) {
  for (const candidate of candidates) {
    for (const path of paths) {
      const next = readPathString(candidate, path);
      if (next) {
        return next;
      }
    }
  }
  return '';
}

export function extractWechatSyncTransferPayload(rawPayload) {
  const candidates = collectPayloadCandidates(rawPayload);
  const title = pickFirstString(candidates, TITLE_PATHS);
  const templateId = pickFirstString(candidates, TEMPLATE_PATHS);
  let contentHtml = pickFirstString(candidates, CONTENT_PATHS);

  if (!contentHtml && typeof rawPayload === 'string') {
    const rawText = rawPayload.trim();
    if (rawText.startsWith('<') && rawText.includes('>')) {
      contentHtml = rawText;
    }
  }

  return {
    title,
    contentHtml,
    templateId
  };
}

