import cloudbase from '@cloudbase/node-sdk';
import { createPgUserHandler } from '../../shared/pg-user-handler.mjs';
import { createRuntimeManager } from '../../shared/runtime-manager.mjs';

export const main = createPgUserHandler({ parseContext: cloudbase.parseContext, createManager: createRuntimeManager });
