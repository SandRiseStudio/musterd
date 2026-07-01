import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  BindingSchema,
  bindingSeat,
  WORKSPACE_SPEC_FILE,
  WorkspaceSpecSchema,
  type Binding,
  type ClaimTarget,
  type WorkspaceSpec,
} from '@musterd/protocol';
import { parseClaimTarget } from './claim-client.js';

/**
 * A v0.3 claim credential resolved from env (ADR 075 Decision 1) — the P3 successor to {@link Identity}.
 * The agent key (mskey_) is the team-level authenticator; `target` is the seat/role/observe to claim;
 * `grant` (msgr_) is an optional pre-issued grant that skips the pending/admin-approval lane. The member
 * name is NOT carried here — it is resolved by the server's `occupied` response (the seat it assigned).
 */
export interface ClaimCredential {
  team: string;
  agentKey: string;
  target: ClaimTarget;
  grant?: string;
  surface: string;
}

/**
 * Read the v0.3 claim credential from `MUSTERD_*` env (ADR 075 Decision 1): `MUSTERD_TEAM` +
 * `MUSTERD_AGENT_KEY` + `MUSTERD_CLAIM` (+ optional `MUSTERD_GRANT`, + `MUSTERD_SURFACE`). Returns null
 * if any required var is absent or `MUSTERD_CLAIM` doesn't parse to a claim target. Additive + unwired:
 * the live `claim`/`join` token path stays until the atomic cutover wires this in.
 */
export function claimCredentialFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { team: string; credential: ClaimCredential } | null {
  const team = env['MUSTERD_TEAM'];
  const agentKey = env['MUSTERD_AGENT_KEY'];
  const claim = env['MUSTERD_CLAIM'];
  if (!team || !agentKey || !claim) return null;
  let target: ClaimTarget;
  try {
    target = parseClaimTarget(claim);
  } catch {
    return null;
  }
  const grant = env['MUSTERD_GRANT'];
  return {
    team,
    credential: {
      team,
      agentKey,
      target,
      ...(grant !== undefined ? { grant } : {}),
      surface: env['MUSTERD_SURFACE'] ?? 'cli',
    },
  };
}

export interface Identity {
  name: string;
  /** The Bearer secret this identity authenticates with (v0.3, ADR 075): a team agent key (`mskey_`)
   *  for an agent seat, or a human credential (`mscr_`) for a person. Replaces the v0.2 seat `token`. */
  key: string;
  surface: string;
  /** Optional pre-issued grant (`msgr_`) carried from the binding/env so a *live* claim (the
   *  `inbox --wait`/`--watch` WS handshake) skips the pending lane, matching the one-shot claim path. */
  grant?: string;
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
  /** The bound seat name (v0.3: the fixed seat of a `seat`-policy binding; role pools have none). */
  seat: string;
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
/**
 * Resolve a ready {@link Identity} from the v0.3 env (ADR 075), reusing {@link claimCredentialFromEnv}.
 * Only a **fixed-seat** target (`MUSTERD_CLAIM=seat:<name>`) yields a direct identity — the seat name is
 * known up front, and `key` = the team agent key. A `role:` pool or `observe` target has no client-side
 * seat name (it's learned from the `occupied` frame at claim time, ADR 075), so there is no direct env
 * identity for those — the claim flow (`musterd claim`/`join`) resolves them and caches the result.
 */
export function identityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { team: string; identity: Identity } | null {
  const cred = claimCredentialFromEnv(env);
  if (!cred) return null;
  const target = cred.credential.target;
  if (!('seat' in target)) return null;
  return {
    team: cred.team,
    identity: {
      name: target.seat,
      key: cred.credential.agentKey,
      surface: cred.credential.surface,
      ...(cred.credential.grant !== undefined ? { grant: cred.credential.grant } : {}),
    },
  };
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
 * Persist the **secret-free** committable launch spec to `<dir>/.musterd/workspace.json` (ADR: the
 * committed launch spec). Unlike {@link saveBinding} this holds NO secret — so it is written with
 * normal perms (no 0600) and is deliberately NOT gitignored, so `git add`ing it makes a fresh
 * clone/worktree self-wireable via `musterd wire`. Callers pass only the non-secret fields; if a full
 * Binding is handed in, `WorkspaceSpecSchema.parse` drops `agent_key`/`grant` so a secret can never
 * leak into the committed file.
 */
export function saveWorkspaceSpec(dir: string, spec: WorkspaceSpec): string {
  const bindingDir = join(dir, BINDING_DIR);
  mkdirSync(bindingDir, { recursive: true });
  const p = join(bindingDir, WORKSPACE_SPEC_FILE);
  // Parse-then-write so any stray secret field on the input object is stripped, never persisted.
  const safe = WorkspaceSpecSchema.parse(spec);
  writeFileSync(p, JSON.stringify(safe, null, 2) + '\n', 'utf8');
  return p;
}

/**
 * Locate + parse the committed workspace spec — the same `.musterd/workspace.json` the MCP adapter
 * falls back to, so the two surfaces can't drift. Walks up from `startDir` like {@link findBinding};
 * returns null if absent or unparseable.
 */
export function findWorkspaceSpec(startDir: string = process.cwd()): WorkspaceSpec | null {
  let dir = startDir;
  for (;;) {
    const p = join(dir, BINDING_DIR, WORKSPACE_SPEC_FILE);
    if (existsSync(p)) {
      try {
        return WorkspaceSpecSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
  // Only a fixed-seat binding has a name to register — the cross-folder name-reuse guard (ADR 020)
  // tracks fixed seats; a role-pool / chat binding resolves its seat server-side and isn't tracked.
  const seat = bindingSeat(binding);
  if (!seat) return;
  try {
    const config = loadConfig();
    config.bindings[resolve(dir)] = {
      team: binding.team,
      seat,
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
   * v0.3 (ADR 075): the team **agent key** (`mskey_`) per team, captured at `team create` so the
   * operator can provision agent workspaces (`musterd agent`) + write `MUSTERD_AGENT_KEY` without
   * re-minting. A secret — like `Identity.key`, it lives only in this 0600 config.
   */
  agentKeys: Record<string, string>;
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
  agentKeys: {},
  rosterHome: {},
};

/** Coerce a possibly-legacy stored identity to the v0.3 shape: a pre-cutover `token` maps to `key`
 *  (it won't authenticate post-cutover — the daemon no longer accepts seat tokens — but stays
 *  well-typed so the vault loads). */
function coerceIdentity<T extends { name: string; surface: string }>(
  raw: T & { key?: string; token?: string },
): T & { key: string } {
  const { token, ...rest } = raw;
  return { ...rest, key: raw.key ?? token ?? '' } as T & { key: string };
}

export function loadConfig(): Config {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    const identities = Object.fromEntries(
      Object.entries(parsed.identities ?? {}).map(([team, id]) => [team, coerceIdentity(id)]),
    );
    return {
      server: process.env['MUSTERD_SERVER'] ?? parsed.server ?? DEFAULT.server,
      ...(parsed.current ? { current: parsed.current } : {}),
      identities,
      // ADR 059: an old config has no vault — backfill it from `identities` so a previously-cached
      // identity is immediately resolvable by `--as`, and stays so when another member joins.
      knownIdentities: backfillVault(
        identities,
        (parsed.knownIdentities ?? []).map(coerceIdentity),
      ),
      bindings: parsed.bindings ?? {},
      agentKeys: parsed.agentKeys ?? {},
      rosterHome: parsed.rosterHome ?? {},
    };
  } catch {
    // Fresh objects (not DEFAULT's): callers like recordBinding mutate `bindings`/`identities`.
    return {
      server: process.env['MUSTERD_SERVER'] ?? DEFAULT.server,
      identities: {},
      knownIdentities: [],
      bindings: {},
      agentKeys: {},
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
