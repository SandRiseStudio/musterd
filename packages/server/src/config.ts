import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolvedConfig {
  port: number;
  host: string;
  dbPath: string;
  heartbeatIntervalMs: number;
  presenceTimeoutMs: number;
  reaperIntervalMs: number;
}

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const PRESENCE_TIMEOUT_MS = 45_000;
export const REAPER_INTERVAL_MS = 15_000;
export const DEFAULT_PORT = 4849;
export const DEFAULT_HOST = '127.0.0.1';

export function defaultDbPath(): string {
  return process.env['MUSTERD_DB'] ?? join(homedir(), '.musterd', 'musterd.db');
}

export function resolveConfig(opts?: {
  port?: number;
  host?: string;
  dbPath?: string;
}): ResolvedConfig {
  const envPort = process.env['MUSTERD_PORT'];
  return {
    port: opts?.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    host: opts?.host ?? process.env['MUSTERD_HOST'] ?? DEFAULT_HOST,
    dbPath: opts?.dbPath ?? defaultDbPath(),
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    presenceTimeoutMs: PRESENCE_TIMEOUT_MS,
    reaperIntervalMs: REAPER_INTERVAL_MS,
  };
}
