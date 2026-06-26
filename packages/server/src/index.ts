import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Database } from 'better-sqlite3';
import {
  RECONCILE_DEBOUNCE_MS,
  assertBindSecurity,
  resolveConfig,
  resolveRosterRoots,
} from './config.js';
import type { Ctx } from './context.js';
import { schemaVersion } from './db/migrations.js';
import { openDb } from './db/open.js';
import { log } from './log.js';
import { startReaper } from './presence/reaper.js';
import { reconcileAll } from './projection/reconcile.js';
import { startRosterWatcher } from './projection/watcher.js';
import { activePresenceBySurface, slowestInboxLagMs } from './store/metrics.js';
import { registerRuntimeGauges, startTelemetry, telemetryEnabled } from './telemetry.js';
import { handleHttp } from './transport/http.js';
import { Hub } from './transport/hub.js';
import { attachWsServer } from './transport/ws.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  /** Path to a PEM certificate to serve native TLS (wss://); pair with tlsKey (ADR 040). */
  tlsCert?: string;
  /** Path to the PEM private key for tlsCert. */
  tlsKey?: string;
  /** Acknowledge a TLS-terminating proxy/overlay in front, allowing a non-loopback plaintext bind. */
  trustProxy?: boolean;
  /** Inject a database (e.g. an in-memory one) for tests; bypasses dbPath. */
  db?: Database;
  /** Roster roots to project + watch (ADR 058). Defaults to {@link resolveRosterRoots}; pass an
   * explicit list to keep tests hermetic (no global-config dependency). `[]` disables reconcile. */
  rosterRoots?: string[];
}

export interface RunningServer {
  listen: () => Promise<{ port: number; host: string }>;
  close: () => Promise<void>;
  db: Database;
  /** The bound port, available after listen() resolves. */
  readonly port: number;
  /** The resolved database path this daemon serves (diagnostics — which db is live). */
  readonly dbPath: string;
  /** The scheme this listener serves: `wss` with native TLS, else `ws` (ADR 040). */
  readonly scheme: 'ws' | 'wss';
}

/** Construct (but do not start) a musterd server. Call listen() to bind. */
export function createServer(opts: ServerOptions = {}): RunningServer {
  const config = resolveConfig(opts);
  // Secure by default (ADR 040): never bind beyond loopback in plaintext. Fail fast, before any
  // resource (db, socket) is opened, with guidance on how to widen the bind safely.
  assertBindSecurity({
    host: config.host,
    hasTls: config.tls !== null,
    trustProxy: config.trustProxy,
  });
  const db = opts.db ?? openDb(config.dbPath);
  const hub = new Hub();
  // Durable roster roots (ADR 058): explicit list (tests) or the rosterHome registry + env override.
  const rosterRoots = opts.rosterRoots ?? resolveRosterRoots();
  const ctx: Ctx = { db, hub, config, rosterRoots };

  const handler = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => {
    void handleHttp(ctx, req, res);
  };
  const http: Server = config.tls
    ? (createHttpsServer(
        { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) },
        handler,
      ) as unknown as Server)
    : createHttpServer(handler);
  attachWsServer(ctx, http);
  let stopReaper: (() => void) | null = null;
  let stopWatcher: (() => void) | null = null;
  let stopTelemetry: (() => Promise<void>) | null = null;
  let boundPort = config.port;

  return {
    db,
    get port() {
      return boundPort;
    },
    get dbPath() {
      return config.dbPath;
    },
    get scheme() {
      return config.scheme;
    },
    async listen() {
      // Start telemetry before binding so the first envelope is already instrumented. No-op + instant
      // when no OTLP endpoint is configured (off by default — observability.md §4 / ADR 015).
      stopTelemetry = await startTelemetry();
      if (telemetryEnabled()) {
        registerRuntimeGauges({
          presenceBySurface: () => activePresenceBySurface(db, config.presenceTimeoutMs),
          inboxLagMs: () => slowestInboxLagMs(db),
        });
      }
      // Boot floor (ADR 058): project the durable files into the db before serving, so the roster the
      // first request sees matches git. Idempotent — safe to re-run; the watcher takes over at runtime.
      if (rosterRoots.length > 0) {
        const summary = reconcileAll(db, rosterRoots);
        log.info({ msg: 'reconcile_boot', teams: summary.length, roots: rosterRoots.length });
      }
      return await new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, () => {
          const addr = http.address();
          boundPort = typeof addr === 'object' && addr ? addr.port : config.port;
          stopReaper = startReaper(ctx);
          if (rosterRoots.length > 0) {
            stopWatcher = startRosterWatcher(rosterRoots, RECONCILE_DEBOUNCE_MS, () => {
              reconcileAll(db, rosterRoots);
            });
          }
          log.info({
            msg: 'listening',
            host: config.host,
            port: boundPort,
            scheme: config.scheme,
            trustProxy: config.trustProxy,
            db: config.dbPath,
            schema: schemaVersion(db),
          });
          resolve({ port: boundPort, host: config.host });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        stopReaper?.();
        stopWatcher?.();
        void stopTelemetry?.();
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
