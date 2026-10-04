import cloudbase from '@cloudbase/node-sdk';
import { authorizeScanner, runScanBatch, selectDueTargets } from '../../shared/scanner.mjs';

const COLLECTIONS = { targets: 'guoman_monitor_targets', series: 'guoman_series' };

function checked(result) { if (result?.code) throw result; return result; }
function row(result) { checked(result); return Array.isArray(result?.data) ? result.data[0] : result?.data; }

function createScanStore(db) {
  return {
    getSeries: async id => row(await db.collection(COLLECTIONS.series).doc(id).get()),
    updateSeries: async (id, patch) => checked(await db.collection(COLLECTIONS.series).doc(id).update(patch)),
    updateTarget: async (id, patch) => checked(await db.collection(COLLECTIONS.targets).doc(id).update(patch)),
    claimTarget: (id, now) => db.runTransaction(async tx => {
      const doc = tx.collection(COLLECTIONS.targets).doc(id);
      const target = row(await doc.get());
      if (!target || Date.parse(target.nextScanAt) > +now || Date.parse(target.leaseUntil || '') > +now) return false;
      checked(await doc.update({ leaseUntil: new Date(+now + 10 * 60 * 1000).toISOString() }));
      return true;
    }),
  };
}

/** Server timer entry; never exposes an on-demand client scan endpoint. */
export async function main(event) {
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
  const identity = app.auth().getUserInfo();
  if (!authorizeScanner(event, identity, process.env.GUOMAN_SCAN_SECRET)) {
    return { ok: false, error: { code: 'FORBIDDEN', message: '扫描仅允许配置了调度密钥的服务器定时触发器调用。' } };
  }
  const db = app.database();
  const now = new Date();
  // Pull only small due queues, rather than reading or crawling the entire catalogue.
  const [users, hot] = await Promise.all(['user', 'hot'].map(source => db.collection(COLLECTIONS.targets)
    .where({ source, nextScanAt: db.command.lte(now.toISOString()) })
    .orderBy('nextScanAt', 'asc').limit(20).get()));
  checked(users); checked(hot);
  const targets = selectDueTargets([...(users.data || []), ...(hot.data || [])], now);
  const result = await runScanBatch({ targets, store: createScanStore(db), now });
  return { ok: true, data: result };
}
