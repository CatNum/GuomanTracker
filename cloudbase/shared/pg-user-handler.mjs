import { createManagementTransport } from './pg-management-transport.mjs';
import { createPgStore } from './pg-store.mjs';
import { createUserService } from './user-service.mjs';

const unauthenticated = () => ({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录账号。' } });
const unavailable = () => ({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '云服务暂时不可用，请稍后重试。' } });

/** One handler may cache the static catalog, but all user state belongs to one invocation. */
export function createPgUserHandler({ app, createManager, loadSeed }) {
  let seedPromise;
  return async function main(event) {
    try {
      const auth = app.auth();
      const trusted = await auth.getUserInfo();
      if (typeof trusted?.uid !== 'string' || !trusted.uid.trim() || trusted.uid.length > 256 || trusted.isAnonymous === true) return unauthenticated();
      if (!seedPromise) seedPromise = Promise.resolve().then(loadSeed).catch((error) => { seedPromise = undefined; throw error; });
      const seed = await seedPromise;
      const manager = createManager();
      const store = createPgStore(createManagementTransport(manager, { libraryMode: event?.action === 'library' }));
      const service = createUserService({ store, seed });
      let displayName = '我的账号';
      let avatarUrl;
      if (event?.action === 'library' && typeof auth.getEndUserInfo === 'function') {
        try {
          const profile = await auth.getEndUserInfo(trusted.uid);
          displayName = profile?.userInfo?.nickName || displayName;
          avatarUrl = profile?.userInfo?.avatarUrl;
        } catch { /* Optional profile metadata does not block account operations. */ }
      }
      return await service(event, { uid: trusted.uid, displayName, avatarUrl, isAnonymous: trusted.isAnonymous });
    } catch {
      return unavailable();
    }
  };
}
