import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Identity {
  name: string;
  token: string;
  surface: string;
}

export interface Config {
  server: string;
  current?: string;
  identities: Record<string, Identity>;
}

export function configPath(): string {
  return process.env['MUSTERD_CONFIG'] ?? join(homedir(), '.musterd', 'config.json');
}

const DEFAULT: Config = { server: 'http://localhost:4849', identities: {} };

export function loadConfig(): Config {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      server: process.env['MUSTERD_SERVER'] ?? parsed.server ?? DEFAULT.server,
      ...(parsed.current ? { current: parsed.current } : {}),
      identities: parsed.identities ?? {},
    };
  } catch {
    return {
      ...DEFAULT,
      server: process.env['MUSTERD_SERVER'] ?? DEFAULT.server,
    };
  }
}

export function saveConfig(config: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
}

/** Derive the WS base URL from the HTTP server URL. */
export function wsBase(server: string): string {
  return server.replace(/^http/, 'ws');
}
