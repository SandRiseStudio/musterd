import type { Database } from 'better-sqlite3';
import type { ResolvedConfig } from './config.js';
import type { Hub } from './transport/hub.js';

/** Shared server context threaded through transports and the router. */
export interface Ctx {
  db: Database;
  hub: Hub;
  config: ResolvedConfig;
}
