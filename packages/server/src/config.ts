import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export interface TlsConfig {
  /** Filesystem path to the PEM certificate (chain). */
  certPath: string;
  /** Filesystem path to the PEM private key. */
  keyPath: string;
}

export interface ResolvedConfig {
  port: number;
  host: string;
  dbPath: string;
  heartbeatIntervalMs: number;
  presenceTimeoutMs: number;
  reaperIntervalMs: number;
  reclaimGraceMs: number;
  /** TTL (ms) of a seat resume grant issued on approval + refreshed on each clean occupy (ADR 087). */
  resumeTtlMs: number;
  /** Idle TTL after which an unused observer seat is reaped (ADR 064). */
  observerTtlMs: number;
  /** Grace a same-workspace successor must stay attached before it reaps its predecessor (ADR 092):
   * long enough that a transient health-check probe disconnects first (so it never evicts the live
   * seat), short enough that a real reload orphan is reaped promptly. */
  supersedeGraceMs: number;
  /** Native TLS material, or null to serve plaintext (ADR 040). */
  tls: TlsConfig | null;
  /** Operator acknowledges a TLS-terminating proxy/overlay in front (ADR 040). */
  trustProxy: boolean;
  /** The scheme this listener actually serves: `wss` only with native TLS. */
  scheme: 'ws' | 'wss';
  /** Extra Host header hostnames allowed on the WS upgrade (besides loopback + bound host). */
  allowedHosts: string[];
  /** Origin values allowed on the WS upgrade (CLI/MCP clients send none; browsers do). */
  allowedOrigins: string[];
  /** Absolute path to a built web UI to serve same-origin (ADR 062), or null to stay API-only. */
  webRoot: string | null;
  /** The commit this daemon booted from (ADR 130), or null when not running from a git checkout.
   * Resolved by the embedder (`musterd serve`) at boot; surfaced on `/health` as `build` so
   * `service status` can name how far the running daemon is behind `origin/main`. */
  buildRef: string | null;
}

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const PRESENCE_TIMEOUT_MS = 45_000;
export const REAPER_INTERVAL_MS = 15_000;
/** Single-active grace: a dropped holder may reclaim its member for this long before it frees (ADR 010). */
export const RECLAIM_GRACE_MS = 45_000;
/** Idle observer seats (ADR 063) are reaped after this long with no connection (ADR 064). */
export const OBSERVER_TTL_MS = 86_400_000; // 24h
/** A seat resume grant (ADR 087) is valid for this long, refreshed on every clean occupy. */
export const RESUME_TTL_MS = 86_400_000; // 24h
/** A same-workspace successor waits this long, still attached, before reaping its predecessor (ADR
 * 092). Above the ~ms lifetime of a Claude Code health-check probe, below a human-noticeable stall. */
export const SUPERSEDE_GRACE_MS = 5_000;
export const DEFAULT_PORT = 4849;
export const DEFAULT_HOST = '127.0.0.1';

export function defaultDbPath(): string {
  return process.env['MUSTERD_DB'] ?? join(homedir(), '.musterd', 'musterd.db');
}

/** Coalesce a burst of file events (e.g. a multi-file `git checkout`) into one reconcile pass. */
export const RECONCILE_DEBOUNCE_MS = 250;

/**
 * Resolve the roster roots the daemon reconciles (ADR 058 / migration-bootstrap.md). A team is
 * file-backed iff it has a `rosterHome` — written into the global `~/.musterd/config.json` by
 * `musterd team export`. Union with the `MUSTERD_TEAMS_DIR` override (comma/colon-separated) for
 * tests and explicit setups. Reading the global config keeps the daemon decoupled from the CLI
 * package while sharing the `~/.musterd/` home the db already lives in. Best-effort: an absent or
 * unreadable config yields the env-only set.
 */
export function resolveRosterRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  for (const d of (env['MUSTERD_TEAMS_DIR'] ?? '')
    .split(/[,:]/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    roots.add(resolve(d));
  }
  try {
    const cfgPath = env['MUSTERD_CONFIG'] ?? join(homedir(), '.musterd', 'config.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      rosterHome?: Record<string, unknown>;
    };
    for (const v of Object.values(raw.rosterHome ?? {})) {
      if (typeof v === 'string') roots.add(resolve(v));
    }
  } catch {
    // no global config / unreadable → env-only roots
  }
  return [...roots];
}

/** A positive-integer millisecond env value (ADR 040 tunable resilience constants). */
const PosIntMs = z.coerce.number().int().positive();

/** Read a tunable timeout from env, falling back to its compiled-in default. Zod-validated (rule #4). */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = PosIntMs.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${name} must be a positive integer (milliseconds), got ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

/** Parse a truthy env flag (`1`/`true`/`yes`, case-insensitive). */
function envBool(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Split a comma/space-separated env allowlist into trimmed, non-empty entries. */
function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ConfigOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  tlsCert?: string;
  tlsKey?: string;
  trustProxy?: boolean;
  /** Serve a built web UI from this directory, same-origin (ADR 062). */
  webRoot?: string;
  /** The commit this daemon boots from (ADR 130) — resolved by the embedder, e.g. `musterd serve`. */
  buildRef?: string;
}

export function resolveConfig(opts?: ConfigOptions): ResolvedConfig {
  const envPort = process.env['MUSTERD_PORT'];
  const certPath = opts?.tlsCert ?? process.env['MUSTERD_TLS_CERT'];
  const keyPath = opts?.tlsKey ?? process.env['MUSTERD_TLS_KEY'];
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error(
      'TLS is half-configured: set both the certificate (MUSTERD_TLS_CERT / --tls-cert) and the key ' +
        '(MUSTERD_TLS_KEY / --tls-key), or neither.',
    );
  }
  const tls: TlsConfig | null = certPath && keyPath ? { certPath, keyPath } : null;

  return {
    port: opts?.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    host: opts?.host ?? process.env['MUSTERD_HOST'] ?? DEFAULT_HOST,
    dbPath: opts?.dbPath ?? defaultDbPath(),
    heartbeatIntervalMs: envMs('MUSTERD_HEARTBEAT_INTERVAL_MS', HEARTBEAT_INTERVAL_MS),
    presenceTimeoutMs: envMs('MUSTERD_PRESENCE_TIMEOUT_MS', PRESENCE_TIMEOUT_MS),
    reaperIntervalMs: envMs('MUSTERD_REAPER_INTERVAL_MS', REAPER_INTERVAL_MS),
    reclaimGraceMs: envMs('MUSTERD_RECLAIM_GRACE_MS', RECLAIM_GRACE_MS),
    resumeTtlMs: envMs('MUSTERD_RESUME_TTL_MS', RESUME_TTL_MS),
    observerTtlMs: envMs('MUSTERD_OBSERVER_TTL_MS', OBSERVER_TTL_MS),
    supersedeGraceMs: envMs('MUSTERD_SUPERSEDE_GRACE_MS', SUPERSEDE_GRACE_MS),
    tls,
    trustProxy: opts?.trustProxy ?? envBool('MUSTERD_INSECURE_TRUST_PROXY'),
    scheme: tls ? 'wss' : 'ws',
    allowedHosts: envList('MUSTERD_ALLOWED_HOSTS'),
    allowedOrigins: envList('MUSTERD_ALLOWED_ORIGINS'),
    webRoot: webRootOf(opts?.webRoot ?? process.env['MUSTERD_WEB_ROOT']),
    buildRef: opts?.buildRef?.trim() || null,
  };
}

/** Resolve a web-root path to absolute, or null when unset/blank (static serving stays off). */
function webRootOf(raw: string | undefined): string | null {
  return raw && raw.trim() ? resolve(raw.trim()) : null;
}

// ---------------------------------------------------------------------------
// Secured off-loopback bind guard (ADR 040). Pure + unit-testable.
// ---------------------------------------------------------------------------

/** Strip IPv6 brackets and lowercase a bare hostname. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

/** True iff `origin`'s host:port equals the `Host` header — i.e. the daemon's own served page. */
function isSameOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** A host that keeps the daemon on the local machine — never needs TLS (ADR 040). */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || h === '::1') return true;
  // IPv4 loopback block 127.0.0.0/8.
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Refuse to bind beyond loopback in plaintext (Principle 7, ADR 040). A non-loopback bind is allowed
 * only with native TLS or an explicit `--insecure-trust-proxy` acknowledging a TLS-terminating proxy/
 * overlay in front. Throws a helpful refusal (ADR 036 style) otherwise. Pure: takes the decided inputs.
 */
export function assertBindSecurity(cfg: {
  host: string;
  hasTls: boolean;
  trustProxy: boolean;
}): void {
  if (isLoopbackHost(cfg.host)) return;
  if (cfg.hasTls || cfg.trustProxy) return;
  throw new Error(
    `refusing to bind ${cfg.host} in plaintext — a non-loopback bind exposes musterd beyond this machine. ` +
      'Either configure TLS (MUSTERD_TLS_CERT + MUSTERD_TLS_KEY, or --tls-cert/--tls-key) for native ' +
      'wss://, or pass --insecure-trust-proxy (MUSTERD_INSECURE_TRUST_PROXY=1) when a TLS-terminating ' +
      'proxy or overlay sits in front. To share a team across machines without exposing a port, run an ' +
      'overlay (Tailscale/WireGuard) and keep the bind on loopback — see docs/guides/cross-network-overlay.md.',
  );
}

/** Extract the bare hostname from a `Host` header value (`host`, `host:port`, `[::1]:port`). */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return (end >= 0 ? h.slice(1, end) : h).toLowerCase();
  }
  const colon = h.indexOf(':');
  return (colon >= 0 ? h.slice(0, colon) : h).toLowerCase();
}

/**
 * Origin/Host gate for the WS upgrade (ADR 040) — blunts cross-site / DNS-rebinding abuse. Pure so it
 * can be unit-tested without a socket. Runs unconditionally (rebinding can target loopback too).
 */
export function checkUpgrade(
  headers: { host?: string | undefined; origin?: string | undefined },
  cfg: { boundHost: string; allowedHosts: string[]; allowedOrigins: string[] },
): { ok: true } | { ok: false; reason: string } {
  // A present Origin means a browser; legitimate musterd clients (CLI, MCP via `ws`) send none. Allow
  // an explicitly-listed origin, OR a *same-origin* page the daemon itself serves — Origin host:port
  // equals the Host header (ADR 062, daemon static-serve). A cross-site/DNS-rebinding Origin differs
  // from Host and is still refused.
  if (
    headers.origin !== undefined &&
    !cfg.allowedOrigins.includes(headers.origin) &&
    !isSameOrigin(headers.origin, headers.host)
  ) {
    return { ok: false, reason: `origin not allowed: ${headers.origin}` };
  }
  if (!headers.host) return { ok: false, reason: 'missing Host header' };
  const hostname = hostnameOf(headers.host);
  const allowed =
    isLoopbackHost(hostname) ||
    hostname === normalizeHost(cfg.boundHost) ||
    cfg.allowedHosts.some((h) => normalizeHost(h) === hostname);
  if (!allowed) return { ok: false, reason: `host not allowed: ${headers.host}` };
  return { ok: true };
}
