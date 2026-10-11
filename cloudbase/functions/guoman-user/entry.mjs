import cloudbase from '@cloudbase/node-sdk';
import CloudBase from '@cloudbase/manager-node';
import { readFile } from 'node:fs/promises';
import { createPgUserHandler } from '../../shared/pg-user-handler.mjs';

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const envId = 'guoman-d1goxm3hhb53752a4';

export const main = createPgUserHandler({
  app,
  loadSeed: async () => {
    const snapshot = JSON.parse(await readFile(new URL('../../seed/catalog.json', import.meta.url), 'utf8'));
    if (!Array.isArray(snapshot.items)) throw new Error('目录快照无效');
    return snapshot.items;
  },
  createManager: () => {
    // SCF provides short-lived credentials. Read them inside each invocation.
    const secretId = process.env.TENCENTCLOUD_SECRETID;
    const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
    const token = process.env.TENCENTCLOUD_SESSIONTOKEN;
    if (!secretId || !secretKey || !token) throw new Error('运行时管理凭证缺失');
    return new CloudBase({ envId, region: 'ap-shanghai', secretId, secretKey, token });
  },
});
