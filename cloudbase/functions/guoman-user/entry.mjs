import cloudbase from '@cloudbase/node-sdk';
import { readFile } from 'node:fs/promises';
import { createUserService } from '../../shared/user-service.mjs';
import { createCloudbaseStore } from '../../shared/cloudbase-store.mjs';

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
let service;

export async function main(event) {
  try {
    // getUserInfo reads CloudBase runtime's verified identity, not event.uid.
    const trusted = app.auth().getUserInfo();
    if (!trusted.uid || trusted.isAnonymous) return { ok: false, error: { code: 'UNAUTHENTICATED', message: '请先通过微信登录。' } };
    if (!service) {
      const snapshot = JSON.parse(await readFile(new URL('../../seed/catalog.json', import.meta.url), 'utf8'));
      service = createUserService({ store: createCloudbaseStore(app.database()), seed: snapshot.items });
    }
    // Profile enrichment is optional; identity never depends on a user-supplied profile.
    let displayName = '微信用户';
    let avatarUrl;
    if (event?.action === 'library') try {
      const profile = await app.auth().getEndUserInfo(trusted.uid);
      displayName = profile.userInfo?.nickName || displayName;
      avatarUrl = profile.userInfo?.avatarUrl;
    } catch { /* Personal operations still work when optional profile lookup fails. */ }
    return await service(event, { uid: trusted.uid, displayName, avatarUrl, isAnonymous: trusted.isAnonymous });
  } catch {
    return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '云服务暂时不可用，请稍后重试。' } };
  }
}
