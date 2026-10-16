import { createCatalogHandler, createCatalogHttpHandler } from '../../shared/catalog-service.mjs';
import { createManagementTransport } from '../../shared/pg-management-transport.mjs';
import { createRuntimeManager } from '../../shared/runtime-manager.mjs';

const options = {
  createStore: () => createManagementTransport(createRuntimeManager(), { libraryMode: true }),
};
const sdkHandler = createCatalogHandler(options);
const httpHandler = createCatalogHttpHandler(options);
export const main = (event) => Object.hasOwn(event || {}, 'httpMethod') ? httpHandler(event) : sdkHandler(event);
