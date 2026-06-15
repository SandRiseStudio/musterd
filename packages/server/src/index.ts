import { createServer as createHttpServer, type Server } from 'node:http';
import type { Database } from 'better-sqlite3';
import { resolveConfig } from './config.js';
import type { Ctx } from './context.js';
import { openDb } from './db/open.js';
import { log } from './log.js';
import { startReaper } from './presence/reaper.js';
import { handleHttp } from './transport/http.js';
import { Hub } from './transport/hub.js';
import { attachWsServer } from './transport/ws.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  /** Inject a database (e.g. an in-memory one) for tests; bypasses dbPath. */
  db?: Database;
}

export interface RunningServer {
  listen: () => Promise<{ port: number; host: string }>;
  close: () => Promise<void>;
  db: Database;
  /** The bound port, available after listen() resolves. */
  readonly port: number;
}

/** Construct (but do not start) a musterd server. Call listen() to bind. */
export function createServer(opts: ServerOptions = {}): RunningServer {
  const config = resolveConfig(opts);
  const db = opts.db ?? openDb(config.dbPath);
  const hub = new Hub();
  const ctx: Ctx = { db, hub, config };

  const http: Server = createHttpServer((req, res) => {
    void handleHttp(ctx, req, res);
  });
  attachWsServer(ctx, http);
  let stopReaper: (() => void) | null = null;
  let boundPort = config.port;

  return {
    db,
    get port() {
      return boundPort;
    },
    listen() {
      return new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, () => {
          const addr = http.address();
          boundPort = typeof addr === 'object' && addr ? addr.port : config.port;
          stopReaper = startReaper(ctx);
          log.info({ msg: 'listening', host: config.host, port: boundPort });
          resolve({ port: boundPort, host: config.host });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        stopReaper?.();
        http.close(() => {
          if (!opts.db) db.close();
          resolve();
        });
        // Force-close lingering keep-alive/WS sockets so tests exit promptly.
        http.closeAllConnections?.();
      });
    },
  };
}

export { resolveConfig } from './config.js';
export { openDb } from './db/open.js';
export { seedDawn } from './db/seed.js';
