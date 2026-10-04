// SCF loads index.main with CommonJS; domain modules remain portable ES modules.
let runtime;
exports.main = async (event, context) => {
  try {
    runtime ??= import('./entry.mjs');
    return await (await runtime).main(event, context);
  } catch {
    runtime = undefined;
    return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '云服务暂时不可用，请稍后重试。' } };
  }
};
