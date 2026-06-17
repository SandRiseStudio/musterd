import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BINDING_DIR, BINDING_FILE, BindingSchema, type Binding } from '@musterd/protocol';

export interface Identity {
  name: string;
  token: string;
  surface: string;
}

/**
 * A tokenless reference to a workspace binding, keyed by absolute folder path in the global
 * config's `bindings` registry (ADR 020). It records *where* each member is bound so init can
 * detect cross-folder name reuse — the one collision-guard case the per-folder binding file can't
 * see on its own (there is no other global index of bindings). Deliberately holds **no token**:
 * secrets live only in the 0600 `.musterd/binding.json`, never duplicated into this registry.
 */
export interface BindingRef {
  team: string;
  member: string;
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
  recordBinding(dir, binding);
  return p;
}

/**
 * Record (tokenless) where a member is bound, keyed by absolute folder path, in the global config's
 * `bindings` registry (ADR 020) — so a later init can warn when a name is already bound in *another*
 * folder. Best-effort: the binding file is the source of truth, so a registry write failure must
 * never defeat `saveBinding`.
 */
function recordBinding(dir: string, binding: Binding): void {
  try {
    const config = loadConfig();
    config.bindings[resolve(dir)] = {
      team: binding.team,
      member: binding.member,
      surface: binding.surface,
    };
    saveConfig(config);
  } catch {
    // registry is advisory; never let it break the primary binding write
  }
}

export interface Config {
  server: string;
  current?: string;
  identities: Record<string, Identity>;
  /** ADR 020: tokenless registry of where members are bound, keyed by absolute folder path. */
  bindings: Record<string, BindingRef>;
}

export function configPath(): string {
  return process.env['MUSTERD_CONFIG'] ?? join(homedir(), '.musterd', 'config.json');
}

const DEFAULT: Config = { server: 'http://localhost:4849', identities: {}, bindings: {} };

export function loadConfig(): Config {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      server: process.env['MUSTERD_SERVER'] ?? parsed.server ?? DEFAULT.server,
      ...(parsed.current ? { current: parsed.current } : {}),
      identities: parsed.identities ?? {},
      bindings: parsed.bindings ?? {},
    };
  } catch {
    // Fresh objects (not DEFAULT's): callers like recordBinding mutate `bindings`/`identities`.
    return {
      server: process.env['MUSTERD_SERVER'] ?? DEFAULT.server,
      identities: {},
      bindings: {},
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
