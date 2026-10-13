import { createCatalogHandler } from '../../shared/catalog-service.mjs';
import { createManagementTransport } from '../../shared/pg-management-transport.mjs';
import { createRuntimeManager } from '../../shared/runtime-manager.mjs';

export const main = createCatalogHandler({
  createStore: () => createManagementTransport(createRuntimeManager(), { libraryMode: true }),
});
