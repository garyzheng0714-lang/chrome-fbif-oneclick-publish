export async function publishGenericByAutofill({ tabId, payload, runtime }) {
  const executeResult = await runtime.withTimeout(
    runtime.executeInTab({
      tabId,
      func: runtime.autoFillFunc,
      args: [
        {
          platformId: payload.platformId,
          title: payload.title,
          coverUrl: payload.coverUrl,
          contentHtml: payload.contentHtml,
          textPlain: payload.textPlain,
          images: payload.images,
          timeoutMs: 12_000
        }
      ]
    }),
    50_000,
    `${payload.platformName} 自动填充超时`
  );

  const detail = executeResult?.[0]?.result;
  if (!detail?.ok) {
    return {
      ok: false,
      error: detail?.error || `${payload.platformName} 自动填充失败`
    };
  }

  return {
    ok: true,
    warnings: detail.warnings ?? [],
    detail
  };
}
