let runtime;
exports.main = async (event) => {
  try {
    runtime ??= import('./entry.mjs');
    return await (await runtime).main(event);
  } catch {
    runtime = undefined;
    return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '目录读取失败，请稍后重试。' } };
  }
};
