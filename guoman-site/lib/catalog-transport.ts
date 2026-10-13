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
  scheduleCheckedAt: z.string().max(80).optional(), latestEpisode: z.number().int().min(1).max(10000).optional(),
  monitoring: z.enum(['queued', 'active', 'unsupported', 'error']).optional(),
  metadataPending: z.boolean().optional(), lastScanAt: z.string().max(80).optional(),
});
const catalogPageSchema = z.object({ items: z.array(animeSchema).max(200), nextAfter: z.string().max(256) });
export type CatalogData = { items: z.infer<typeof animeSchema>[] };

/** loadCatalogData（读取PG目录）：游客与账号使用相同分页入口，全部确认后才返回。 */
export async function loadCatalogData({ call }: {
  call: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
}): Promise<CatalogData> {
  const items: CatalogData['items'] = [];
  const seen = new Set<string>();
  let after = '';
  for (let page = 0; page < 51; page++) {
    const data = catalogPageSchema.parse(await call('getCatalog', { after }));
    for (const item of data.items) {
      if (seen.has(item.id) || item.id <= after) throw new Error('目录分页不一致，请重新读取。');
      seen.add(item.id);
      items.push(item);
    }
    if (items.length > 10000) throw new Error('目录超过读取上限。');
    if (!data.nextAfter) return { items };
    if (!data.items.length || data.nextAfter !== data.items.at(-1)?.id || data.nextAfter <= after)
      throw new Error('目录分页游标无效。');
    after = data.nextAfter;
  }
  throw new Error('目录分页超过读取上限。');
}
