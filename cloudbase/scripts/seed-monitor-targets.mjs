import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seedHotTargets } from '../shared/scanner.mjs';

const root = new URL('../../', import.meta.url);
function checked(result) { if (result?.code) throw result; return result; }
async function readDocument(ref) {
  try {
    const found = checked(await ref.get());
    return Array.isArray(found.data) ? found.data[0] : found.data;
  } catch (error) {
    if (['DOCUMENT_NOT_FOUND', 'DATABASE_DOCUMENT_NOT_FOUND'].includes(error?.code)) return null;
    throw error;
  }
}
const idsArg = process.argv.find(arg => arg.startsWith('--ids='));
const ids = [...new Set((idsArg?.slice(6) || '').split(',').map(id => id.trim()).filter(Boolean))];
if (!ids.length || ids.length > 30) throw new Error('请通过 --ids=目录节目标识,... 明确指定 1 至 30 个热门节目。');
const snapshot = JSON.parse(await readFile(new URL('guoman-site/data/catalog.json', root), 'utf8'));
const selected = ids.map(id => {
  const item = snapshot.items.find(candidate => candidate.id === id);
  if (!item) throw new Error(`目录未找到节目标识：${id}`);
  return item;
});
const now = new Date();
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'preview', targets: seedHotTargets(selected, [], now) }, null, 2));
} else {
  const env = process.env.CLOUDBASE_ENV_ID;
  if (!env || /placeholder|your|replace|<|>/iu.test(env)) throw new Error('实际写入前需在管理员环境配置 CLOUDBASE_ENV_ID。');
  const require = createRequire(new URL('../functions/guoman-scan/package.json', import.meta.url));
  const cloudbase = require('@cloudbase/node-sdk');
  const options = { env };
  if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
    options.secretId = process.env.TENCENTCLOUD_SECRETID;
    options.secretKey = process.env.TENCENTCLOUD_SECRETKEY;
  }
  const db = cloudbase.init(options).database();
  const saved = checked(await db.collection('guoman_monitor_targets').where({ source: 'hot' }).limit(31).get());
  const knownTargets = await Promise.all(ids.map(id => readDocument(db.collection('guoman_monitor_targets').doc(id))));
  const existing = [...(saved.data || []), ...knownTargets.filter(target => target?.source === 'user')];
  const targets = seedHotTargets(selected, existing, now);
  const hotIds = new Set(existing.filter(target => target.source === 'hot').map(target => target.seriesId));
  for (const target of targets) hotIds.add(target.seriesId);
  if (hotIds.size > 30) throw new Error('数据库中累计热门监控目标将超过 30 条，请先调整管理员热门名单。');
  // Deterministic IDs make re-running the import idempotent. Never overwrite a user target.
  for (const target of targets) {
    const series = selected.find(item => item.id === target.seriesId);
    await db.runTransaction(async tx => {
      const ref = tx.collection('guoman_monitor_targets').doc(target.seriesId);
      const old = await readDocument(ref);
      if (old?.source === 'user') return;
      const seriesRef = tx.collection('guoman_series').doc(target.seriesId);
      const known = await readDocument(seriesRef);
      if (!known) checked(await seriesRef.set({ ...series, monitoring: 'queued', nextScanAt: target.nextScanAt }));
      const { _id, ...prior } = old || {};
      checked(await ref.set({ ...prior, ...target }));
    });
  }
  console.log(JSON.stringify({ imported: targets.length, env, script: fileURLToPath(import.meta.url) }));
}
