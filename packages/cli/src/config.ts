import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  BindingSchema,
  bindingSeat,
  assertWritableBinding,
  PENDING_DIR,
  WORKSPACE_SPEC_FILE,
  WorkspaceSpecSchema,
  type Binding,
  type ClaimTarget,
  type WorkspaceSpec,
} from '@musterd/protocol';
import { parseClaimTarget } from './claim-client.js';
import { machineStatePath } from './machinePaths.js';

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

/** Paths already warned about, so a corrupt binding announces itself once rather than on every tool
 *  boundary (this read rides the PostToolUse hook). */
const warnedCorrupt = new Set<string>();

/**
 * `null` here has always meant two very different things — "no binding" and "a binding I could not
 * parse" — and the second one is why #508 was silent for a full session: the seat kept working over
 * MCP while every CLI identity path quietly resolved to nothing. A file that EXISTS but does not
 * parse is a broken workspace, not an unbound one, and it says so. Once per path, on stderr, so it
 * cannot flood a hook or corrupt an MCP stdio channel.
 */
function readBinding(path: string): Binding | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // genuinely absent — the ordinary "not a musterd workspace" answer
  }
  try {
    return BindingSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (!warnedCorrupt.has(path)) {
      warnedCorrupt.add(path);
      const detail = err instanceof Error ? err.message.replace(/\s+/g, ' ').slice(0, 300) : '';
      console.error(
        `[musterd] ${path} exists but does not parse — this workspace has no usable identity until ` +
          `it is repaired, and every musterd command here will behave as if it were unbound. ${detail}`,
      );
    }
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

/**
 * Persist a workspace binding (ADR 018). Holds a token → 0600, and init gitignores `.musterd/`.
 *
 * Two hardenings for session capture (ADR 131 §5, increment 4), mirrored in the MCP adapter's
 * `saveBinding`:
 * - **Merge-guard on `model_observed`.** Same shape, one field over: the observation is hook-written,
 *   so `musterd claim` / `musterd agent` / an autojoin persist all omit it. Losing it silently falls
 *   attestation back to the stale declaration — the failure the observed tier exists to end.
 * - **Merge-guard on `session`.** The capture is hook-written, but most callers rebuild the binding
 *   from state read long before (the ADR 101 model-wipe precedent: every autojoin/reclaim persist
 *   silently dropped `model` until it was carried through) — on a wake, the SessionStart hook
 *   writes `session` and the adapter's first-tool-call autojoin would immediately overwrite it.
 *   So: re-read the on-disk file at write time and preserve its `session` unless the caller
 *   explicitly set one. Preserving is not *reading* the capture (the adapter never consumes it) —
 *   it is refusing to destroy another writer's field.
 * - **Atomic write.** Hook and adapter can write concurrently; tmp-file + rename means a
 *   concurrent reader never sees a torn file (and the 0600 mode exists from the first byte).
 */
export function saveBinding(dir: string, binding: Binding): string {
  const bindingDir = join(dir, BINDING_DIR);
  mkdirSync(bindingDir, { recursive: true });
  const p = join(bindingDir, BINDING_FILE);
  const onDisk = readBinding(p);
  const merged: Binding = {
    ...binding,
    ...(binding.session === undefined && onDisk?.session !== undefined
      ? { session: onDisk.session }
      : {}),
    ...(binding.model_observed === undefined && onDisk?.model_observed !== undefined
      ? { model_observed: onDisk.model_observed }
      : {}),
  };
  // Before anything touches the filesystem: a binding the reader could not parse must not replace
  // one it can. Ahead of the tmp write so a refusal leaves no debris either.
  assertWritableBinding(merged);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
  renameSync(tmp, p);
  recordBinding(dir, merged);
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
  /**
   * The **team home** per team, keyed by slug (install-topology §4): the directory a human stands in
   * so their identity resolves without `--as` or pasting. Written by `musterd human <name>`; the
   * default is `~/musterd/<slug>`.
   *
   * Deliberately a **distinct key from {@link Config.rosterHome}**, not a rename of it. `rosterHome`
   * is ADR 058's *cutover signal* — a team is file-authoritative iff it has one — so provisioning a
   * person a place to stand must never silently flip a db-only team into file-backed mode. They
   * compose (when both exist they should name the same folder, and `team export` defaults into the
   * team home); they do not merge.
   */
  teamHome: Record<string, string>;
}

/** Record a team's roster home (ADR 058 `team export`) — the cutover to file-authoritative. */
export function recordRosterHome(config: Config, slug: string, dir: string): void {
  config.rosterHome[slug] = resolve(dir);
}

/** Record a team's home (install-topology §4) — where the human stands. Never touches `rosterHome`. */
export function recordTeamHome(config: Config, slug: string, dir: string): void {
  config.teamHome[slug] = resolve(dir);
}

/**
 * Where a team's home lives by default: `~/musterd/<slug>`. `~/musterd/` is the natural roof over all
 * of a human's teams — walking between them is `cd` — without itself being a config concept. Visible
 * on purpose: unlike `~/.musterd/` (platform state a person never opens), the home is a place they
 * stand in, so hiding it in a dotdir would contradict the thing it exists to provide.
 */
export function defaultTeamHome(slug: string): string {
  return join(homedir(), 'musterd', slug);
}

/**
 * Read a binding at an **exact** folder (`<dir>/.musterd/binding.json`), without {@link findBinding}'s
 * walk up the tree. The distinction is load-bearing for the team home: `~/musterd/revive` sits under
 * `~`, so a walking read could answer with some ancestor's binding and let one team's floor be
 * written over another's.
 */
export function readBindingAt(dir: string): Binding | null {
  return readBinding(join(dir, BINDING_DIR, BINDING_FILE));
}

/**
 * The paths inside a folder that must never reach a commit: the binding (a live `mscr_`/`mskey_`) and
 * the pending-claim directory beside it.
 */
const CREDENTIAL_EXCLUSIONS = [
  `${BINDING_DIR}/${BINDING_FILE}`,
  `${BINDING_DIR}/${PENDING_DIR}/`,
] as const;

/**
 * Every way a `.gitignore` could already be excluding `target`, derived from the target itself rather
 * than hand-listed: the path, its basename, `**` forms, and each ancestor directory with its `/*` and
 * `/**` variants. Deriving them is what keeps the check honest — a hand-written `.musterd/` covers the
 * binding just as well as the exact path does, and appending a redundant line over someone's working
 * exclusion would be noise presented as a fix.
 */
function excludingSpellings(target: string): Set<string> {
  const clean = target.replace(/\/+$/, '');
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const out = new Set([clean, base, `**/${base}`]);
  const parts = clean.split('/');
  for (let i = 1; i < parts.length; i++) {
    const anc = parts.slice(0, i).join('/');
    out.add(anc);
    out.add(`${anc}/*`);
    out.add(`${anc}/**`);
    out.add(`**/${parts[i - 1]}`);
  }
  return out;
}

/** Compare ignore lines on their meaning, not their punctuation: `/.musterd/` and `.musterd` match. */
function normalizeIgnoreLine(line: string): string {
  return line.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Make `dir` safe to `git add`, and answer whether it now is.
 *
 * `musterd team export` ends by telling you these files are the source of truth and to commit them —
 * but it writes the roster into the same `.musterd/` that holds `binding.json` and its live
 * credential, so following that instruction with `git add -A` commits the key. The first real export
 * of the `revive` team hit exactly this; a hand-written `.gitignore` is the only reason that key is
 * not in git. Nobody else would know to write one, so the command writes it.
 *
 * Appends, never overwrites — an existing `.gitignore` is somebody's work. Each target is checked
 * independently, so a file that covers the binding but not `pending/` gains only the missing line, and
 * a commented-out `# .musterd/binding.json` deliberately does **not** count as cover: that is the case
 * a naive substring check gets wrong, and it gets it wrong in the dangerous direction.
 *
 * Returns "is this folder safe to commit", not "did anything change" — an exclusion that was already
 * present is the caller's happy path, not a reason to suppress the instruction. It never throws: an
 * unwritable directory returns false so the caller can withhold the `git add` line instead of
 * aborting an export whose roster is already on disk.
 *
 * Deliberately not `missingGitignoreEntries` (onboard/init.ts), which asks a human before appending
 * and matches ignore lines exactly. Both differences are wrong here: nothing on this path is
 * interactive, and an exact match would append a redundant line over the hand-written `.musterd/`
 * that is currently the only thing keeping the real team's key out of git.
 */
export function excludeCredentialFromGit(dir: string): boolean {
  const p = join(dir, '.gitignore');
  try {
    const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const present = existing
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .map(normalizeIgnoreLine)
      .filter(Boolean);
    const missing = CREDENTIAL_EXCLUSIONS.filter((target) => {
      const spellings = excludingSpellings(target);
      return !present.some((l) => spellings.has(l));
    });
    if (missing.length === 0) return true;
    const lead = existing === '' || existing.endsWith('\n') ? '' : '\n';
    const block = `${lead}# musterd credential — never commit (ADR 176)\n${missing.join('\n')}\n`;
    writeFileSync(p, existing + block);
    return true;
  } catch {
    return false;
  }
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
  return machineStatePath('MUSTERD_CONFIG', 'config.json');
}

const DEFAULT: Config = {
  server: 'http://localhost:4849',
  identities: {},
  knownIdentities: [],
  bindings: {},
  agentKeys: {},
  rosterHome: {},
  teamHome: {},
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
      teamHome: parsed.teamHome ?? {},
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
      teamHome: {},
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
