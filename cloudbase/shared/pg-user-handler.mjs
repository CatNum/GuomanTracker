import { createManagementTransport } from './pg-management-transport.mjs';
import { createPgStore } from './pg-store.mjs';
import { createUserService } from './user-service.mjs';
import { readInvocationIdentity } from './invocation-identity.mjs';
import { resolveOfficialMetadata } from './submission-metadata.mjs';
import { resolveOfficialEpisode } from './episode-links.mjs';

const unauthenticated = () => ({ ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录账号。' } });
const unavailable = () => ({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '云服务暂时不可用，请稍后重试。' } });

/** One handler may cache the static catalog, but all user state belongs to one invocation. */
export function createPgUserHandler({ parseContext, createManager, loadSeed, getCatalog, resolveMetadata = resolveOfficialMetadata, resolveEpisode = resolveOfficialEpisode }) {
  let seedPromise;
  return async function main(event, context) {
    try {
      const trusted = readInvocationIdentity(context, parseContext);
      if (!trusted) return unauthenticated();
      if (event?.action === 'resolveEpisode') {
        const payload = event.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            Object.keys(payload).length !== 2 || typeof payload.url !== 'string' || payload.url.length > 2048 ||
            !Number.isSafeInteger(payload.episode) || payload.episode < 1 || payload.episode > 10000) {
          return { ok: false, error: { code: 'INVALID_REQUEST', message: '请填写官方节目链接与有效的整数集号。' } };
        }
        try { return { ok: true, data: await resolveEpisode(payload.url, payload.episode) }; }
        catch (error) {
          if (['INVALID_URL', 'INVALID_EPISODE', 'UNSUPPORTED_PLATFORM', 'EPISODE_UNAVAILABLE'].includes(error?.code)) {
            return { ok: false, error: { code: error.code, message: error.message } };
          }
          return { ok: false, error: { code: 'EPISODE_UNAVAILABLE', message: '官方选集暂时无法读取，请稍后重试，或前往官方作品页选集。' } };
        }
      }
      if (!seedPromise) seedPromise = Promise.resolve().then(loadSeed).catch((error) => { seedPromise = undefined; throw error; });
      const seed = await seedPromise;
      if (event?.action === 'getCatalog') {
        if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload) || Object.keys(event.payload).length !== 0 || typeof getCatalog !== 'function') {
          return { ok: false, error: { code: 'INVALID_REQUEST', message: '请求格式无效。' } };
        }
        const catalog = await getCatalog();
        return { ok: true, data: { items: catalog.items, live: catalog.live } };
      }
      const manager = createManager();
      const store = createPgStore(createManagementTransport(manager, { libraryMode: event?.action === 'library' }));
      const service = createUserService({ store, seed, resolveMetadata });
      // Account identity is already verified; optional profile RPC must not delay records.
      return await service(event, { uid: trusted.uid, displayName: '我的账号', isAnonymous: trusted.isAnonymous });
    } catch {
      return unavailable();
    }
  };
}
