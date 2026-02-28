import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { buildWechatPasteHtml } from '../src/shared/wechat-html.js';
import {
  buildImageTextRunSignature,
  buildWechatEditorInsertPlan
} from '../src/shared/wechat-editor-order.js';

const TARGET_TEXT_SIZE = 50_000;
const TARGET_IMAGE_COUNT = 50;
const LIMIT_DURATION_MS = 2_000;
const LIMIT_PEAK_MEMORY_MB = 256;

function buildLongText(length) {
  const unit = '这是用于公众号同步性能基准的正文片段。';
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function buildBenchmarkHtml() {
  const fullText = buildLongText(TARGET_TEXT_SIZE);
  const paragraphSize = Math.max(200, Math.floor(fullText.length / TARGET_IMAGE_COUNT));
  let cursor = 0;
  const blocks = [];

  for (let index = 0; index < TARGET_IMAGE_COUNT; index += 1) {
    const nextCursor = Math.min(fullText.length, cursor + paragraphSize);
    const paragraph = fullText.slice(cursor, nextCursor);
    cursor = nextCursor;
    blocks.push(`<p>${paragraph || '段落补齐内容'}</p>`);
    blocks.push(
      `<figure><img src="https://static.foodtalks.cn/benchmarks/wechat-image-${index + 1}.jpg" alt="图${index + 1}" /></figure>`
    );
    blocks.push(`<figcaption>图片说明 ${index + 1}</figcaption>`);
  }

  if (cursor < fullText.length) {
    blocks.push(`<p>${fullText.slice(cursor)}</p>`);
  }

  return blocks.join('');
}

function toMb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

let peakRssBytes = process.memoryUsage().rss;
const sampleMemory = () => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
};

const pipelineStart = performance.now();
const sourceHtml = buildBenchmarkHtml();
sampleMemory();
const wechatHtml = buildWechatPasteHtml(sourceHtml);
sampleMemory();
const insertPlan = buildWechatEditorInsertPlan(wechatHtml, {
  maxChunkLength: 12_000,
  imageDelayMs: 120,
  textYieldEvery: 4
});
sampleMemory();
const runSignature = buildImageTextRunSignature(wechatHtml, { maxTokens: 500 });
sampleMemory();
const pipelineDurationMs = performance.now() - pipelineStart;

const output = {
  inputChars: sourceHtml.length,
  outputChars: wechatHtml.length,
  imageCount: TARGET_IMAGE_COUNT,
  insertSteps: insertPlan.length,
  runSignatureLength: runSignature.length,
  durationMs: Math.round(pipelineDurationMs),
  peakMemoryMb: toMb(peakRssBytes),
  threshold: {
    durationMs: LIMIT_DURATION_MS,
    peakMemoryMb: LIMIT_PEAK_MEMORY_MB
  },
  pass:
    pipelineDurationMs <= LIMIT_DURATION_MS &&
    toMb(peakRssBytes) <= LIMIT_PEAK_MEMORY_MB
};

console.log(JSON.stringify(output, null, 2));

if (!output.pass) {
  process.exitCode = 1;
}
