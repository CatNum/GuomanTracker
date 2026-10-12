import { createManagementTransport } from './pg-management-transport.mjs';
import { createPgStore } from './pg-store.mjs';
import { createUserService } from './user-service.mjs';
import { readInvocationIdentity } from './invocation-identity.mjs';
import { resolveOfficialMetadata } from './submission-metadata.mjs';

const unauthenticated = () => ({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录账号。' } });
const unavailable = () => ({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '云服务暂时不可用，请稍后重试。' } });

/** One handler may cache the static catalog, but all user state belongs to one invocation. */
export function createPgUserHandler({ app, parseContext, createManager, loadSeed, resolveMetadata = resolveOfficialMetadata }) {
  let seedPromise;
  return async function main(event, context) {
    try {
      const trusted = readInvocationIdentity(context, parseContext);
      if (!trusted) return unauthenticated();
      if (!seedPromise) seedPromise = Promise.resolve().then(loadSeed).catch((error) => { seedPromise = undefined; throw error; });
      const seed = await seedPromise;
      const manager = createManager();
      const store = createPgStore(createManagementTransport(manager, { libraryMode: event?.action === 'library' }));
      const service = createUserService({ store, seed, resolveMetadata });
      let displayName = '我的账号';
      let avatarUrl;
      if (event?.action === 'library') {
        try {
          const auth = app.auth();
          if (typeof auth.getEndUserInfo === 'function') {
            const profile = await auth.getEndUserInfo(trusted.uid);
            displayName = profile?.userInfo?.nickName || displayName;
            avatarUrl = profile?.userInfo?.avatarUrl;
          }
        } catch { /* Optional profile metadata does not block account operations. */ }
      }
      return await service(event, { uid: trusted.uid, displayName, avatarUrl, isAnonymous: trusted.isAnonymous });
    } catch {
      return unavailable();
    }
  };
}
