exports.main = async (...args) => {
  const entry = await import('./entry.mjs');
  return entry.main(...args);
};
