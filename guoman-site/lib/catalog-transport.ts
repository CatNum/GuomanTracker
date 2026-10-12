import { z } from 'zod';

const eventSchema = z.object({
  at: z.number().finite(), label: z.string().max(100), published: z.boolean(), delayed: z.boolean(),
});
const animeSchema = z.object({
  id: z.string().min(1).max(200), title: z.string().min(1).max(200), platform: z.string().max(40),
  url: z.string().url().max(2048), cover: z.string().max(2048), status: z.string().max(40),
  episodes: z.string().max(200), checkedAt: z.string().max(80), source: z.string().max(2048),
  events: z.array(eventSchema).max(5000), days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  time: z.string().max(10).optional(), schedule: z.string().max(500).optional(),
});
const catalogSchema = z.object({ items: z.array(animeSchema).max(10_000), live: z.boolean() });

export type CatalogData = z.infer<typeof catalogSchema>;
export type CatalogTransport = 'http' | 'cloudbase';

/** Validate catalog data at the boundary shared by HTTP and CloudBase transports. */
export function parseCatalogData(value: unknown): CatalogData {
  return catalogSchema.parse(value);
}

/** Read the selected public catalog transport; CloudBase requests require a ready user session. */
export async function loadCatalogData({
  transport,
  accountReady,
  call,
  fetchImpl = fetch,
}: {
  transport: CatalogTransport;
  accountReady: boolean;
  call: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
  fetchImpl?: typeof fetch;
}): Promise<CatalogData | null> {
  if (transport === 'cloudbase') {
    if (!accountReady) return null;
    return parseCatalogData(await call('getCatalog', {}));
  }
  const response = await fetchImpl('/api/catalog');
  if (!response.ok) throw new Error('目录服务暂不可用');
  return parseCatalogData(await response.json());
}

export const catalogTransport: CatalogTransport =
  process.env.NEXT_PUBLIC_CATALOG_TRANSPORT === 'cloudbase' ? 'cloudbase' : 'http';
