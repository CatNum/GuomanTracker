import snapshot from '@/data/catalog.json';
import { createCatalogService } from '../../../../cloudbase/shared/catalog-service.mjs';

const service = createCatalogService({ loadSeed: async () => snapshot.items });

export async function GET() {
  const result = await service.getCatalog();
  return Response.json(result, {
    headers: result.live ? { 'Cache-Control': 'public, max-age=300' } : { 'Cache-Control': 'no-store' },
  });
}
