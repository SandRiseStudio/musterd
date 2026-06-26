import type { Database } from 'better-sqlite3';
import type { ResolvedConfig } from './config.js';
import type { Hub } from './transport/hub.js';

/** Shared server context threaded through transports and the router. */
export interface Ctx {
  db: Database;
  hub: Hub;
  config: ResolvedConfig;
  /** Durable roster roots (ADR 058). Empty ⇒ no file-backed teams; the legacy db-authoritative
   * provisioning path stays in force (per-team cutover, migration-bootstrap.md). */
  rosterRoots: string[];
}
