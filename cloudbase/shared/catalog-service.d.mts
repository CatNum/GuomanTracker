export type CatalogResult = { items: unknown[]; nextAfter: string };
export function createCatalogService(options: { store: { listSeriesPage(after: string): Promise<{ documents: unknown[]; next_after: string }> } }): {
  getCatalog(payload?: { after?: string }): Promise<CatalogResult>;
};
