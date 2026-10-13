import cloudbase from '@cloudbase/node-sdk';
import CloudBase from '@cloudbase/manager-node';
import { readFile } from 'node:fs/promises';
import { createPgUserHandler } from '../../shared/pg-user-handler.mjs';
import { createCatalogService } from '../../shared/catalog-service.mjs';

const envId = 'guoman-d1goxm3hhb53752a4';
let seedPromise;
const loadSeed = async () => {
  if (!seedPromise) seedPromise = readFile(new URL('../../seed/catalog.json', import.meta.url), 'utf8')
    .then((text) => JSON.parse(text)).then((snapshot) => {
      if (!Array.isArray(snapshot.items)) throw new Error('目录快照无效');
      return snapshot.items;
    }).catch((error) => { seedPromise = undefined; throw error; });
  return seedPromise;
};
const catalogService = createCatalogService({ loadSeed });

export const main = createPgUserHandler({
  parseContext: cloudbase.parseContext,
  loadSeed,
  getCatalog: catalogService.getCatalog,
  createManager: () => {
    // SCF provides short-lived credentials. Read them inside each invocation.
    const secretId = process.env.TENCENTCLOUD_SECRETID;
    const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
    const token = process.env.TENCENTCLOUD_SESSIONTOKEN;
    if (!secretId || !secretKey || !token) throw new Error('运行时管理凭证缺失');
    return new CloudBase({ envId, region: 'ap-shanghai', secretId, secretKey, token });
  },
});
