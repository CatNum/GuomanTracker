export type CatalogResult = { items: unknown[]; live: boolean };
export function createCatalogService(options: {
  loadSeed: () => Promise<unknown[]> | unknown[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}): { getCatalog: () => Promise<CatalogResult> };
