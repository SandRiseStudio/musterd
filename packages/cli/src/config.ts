import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, BindingSchema, type Binding } from '@musterd/protocol';

export interface Identity {
  name: string;
  token: string;
  surface: string;
}

/**
 * Locate + parse the workspace binding (ADR 018) — the same `.musterd/binding.json` the MCP
 * adapter reads, so the two surfaces can't drift. An explicit `MUSTERD_BINDING` path wins;
 * otherwise walk up from cwd looking for the file. Returns null if absent or unparseable.
 */
export function findBinding(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Binding | null {
  const explicit = env['MUSTERD_BINDING'];
  if (explicit) return readBinding(explicit);
  let dir = startDir;
  for (;;) {
    const p = join(dir, BINDING_DIR, BINDING_FILE);
    if (existsSync(p)) return readBinding(p);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readBinding(path: string): Binding | null {
  try {
    return BindingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** A fully-specified identity from `MUSTERD_*` env, aligned with the MCP adapter's binding env. */
export function identityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { team: string; identity: Identity } | null {
  const team = env['MUSTERD_TEAM'];
  const member = env['MUSTERD_MEMBER'];
  const token = env['MUSTERD_TOKEN'];
  if (!team || !member || !token) return null;
  return { team, identity: { name: member, token, surface: env['MUSTERD_SURFACE'] ?? 'cli' } };
}

/** Persist a workspace binding (ADR 018). Holds a token → 0600, and init gitignores `.musterd/`. */
export function saveBinding(dir: string, binding: Binding): string {
  const bindingDir = join(dir, BINDING_DIR);
  mkdirSync(bindingDir, { recursive: true });
  const p = join(bindingDir, BINDING_FILE);
  writeFileSync(p, JSON.stringify(binding, null, 2) + '\n', 'utf8');
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
  return p;
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
