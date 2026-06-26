import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * Remove this folder's workspace binding (ADR 058 `unbind`): delete the 0600 `binding.json` and drop
 * its entry from the global `bindings` registry. The inverse of {@link saveBinding}. Returns true if a
 * binding file was actually removed. The durable seat file (if any) is untouched — unbinding stops
 * *this folder* occupying the seat; it does not delete the seat from the team.
 */
export function removeBinding(dir: string): boolean {
  const p = join(dir, BINDING_DIR, BINDING_FILE);
  const existed = existsSync(p);
  if (existed) rmSync(p, { force: true });
  try {
    const config = loadConfig();
    if (config.bindings[resolve(dir)]) {
      delete config.bindings[resolve(dir)];
      saveConfig(config);
    }
  } catch {
    // registry is advisory; never let a cleanup failure mask the binding-file removal
  }
  return existed;
}

/**
 * Record (tokenless) where a member is bound, keyed by absolute folder path, in the global config's
 * `bindings` registry (ADR 020) — so a later init can warn when a name is already bound in *another*
 * folder. Best-effort: the binding file is the source of truth, so a registry write failure must
 * never defeat `saveBinding`.
 */
function recordBinding(dir: string, binding: Binding): void {
  // A policy-only (unclaimed) binding has no member name to register — the cross-folder name-reuse
  // guard (ADR 020) only tracks concrete identities.
  if (!binding.member) return;
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

/** An identity tagged with its team — the shape stored in the multi-identity vault (ADR 059). */
export interface StoredIdentity extends Identity {
  team: string;
}

export interface Config {
  server: string;
  current?: string;
  /** The active/default identity per team (ADR 018). One slot per team — the `current`-team default. */
  identities: Record<string, Identity>;
  /**
   * ADR 059: every identity this machine has joined/claimed, keyed by (team, name). A superset of
   * `identities` that another member joining the same team can't evict, so `--as <name>` always
   * resolves a previously-known identity. Backfilled from `identities` on load.
   */
  knownIdentities: StoredIdentity[];
  /** ADR 020: tokenless registry of where members are bound, keyed by absolute folder path. */
  bindings: Record<string, BindingRef>;
  /**
   * ADR 058 (migration-bootstrap.md): the folder that owns each team's durable roster, keyed by slug.
   * Written by `musterd team export`; it is the **cutover signal** — a team is file-backed (the daemon
   * reconciles its `.musterd/` files) iff it has a `rosterHome`. The daemon reads this same registry to
   * discover its reconcile roots ({@link resolveRosterRoots}).
   */
  rosterHome: Record<string, string>;
}

/** Record a team's roster home (ADR 058 `team export`) — the cutover to file-authoritative. */
export function recordRosterHome(config: Config, slug: string, dir: string): void {
  config.rosterHome[slug] = resolve(dir);
}

/** Upsert an identity into the vault (ADR 059), keyed by (team, name). */
export function rememberIdentity(config: Config, si: StoredIdentity): void {
  const i = config.knownIdentities.findIndex((x) => x.team === si.team && x.name === si.name);
  if (i >= 0) config.knownIdentities[i] = si;
  else config.knownIdentities.push(si);
}

/** Backfill the vault from the legacy per-team `identities` so an old config is migrated on load. */
function backfillVault(
  identities: Record<string, Identity>,
  vault: StoredIdentity[],
): StoredIdentity[] {
  const out = [...vault];
  for (const [team, id] of Object.entries(identities)) {
    if (!out.some((x) => x.team === team && x.name === id.name)) out.push({ team, ...id });
  }
  return out;
}

export function configPath(): string {
  return process.env['MUSTERD_CONFIG'] ?? join(homedir(), '.musterd', 'config.json');
}

const DEFAULT: Config = {
  server: 'http://localhost:4849',
  identities: {},
  knownIdentities: [],
  bindings: {},
  rosterHome: {},
};

export function loadConfig(): Config {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    const identities = parsed.identities ?? {};
    return {
      server: process.env['MUSTERD_SERVER'] ?? parsed.server ?? DEFAULT.server,
      ...(parsed.current ? { current: parsed.current } : {}),
      identities,
      // ADR 059: an old config has no vault — backfill it from `identities` so a previously-cached
      // identity is immediately resolvable by `--as`, and stays so when another member joins.
      knownIdentities: backfillVault(identities, parsed.knownIdentities ?? []),
      bindings: parsed.bindings ?? {},
      rosterHome: parsed.rosterHome ?? {},
    };
  } catch {
    // Fresh objects (not DEFAULT's): callers like recordBinding mutate `bindings`/`identities`.
    return {
      server: process.env['MUSTERD_SERVER'] ?? DEFAULT.server,
      identities: {},
      knownIdentities: [],
      bindings: {},
      rosterHome: {},
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
