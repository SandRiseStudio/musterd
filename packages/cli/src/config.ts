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
  ClaimPolicySchema,
  PENDING_DIR,
  WORKSPACE_SPEC_FILE,
  WorkspaceSpecSchema,
  type Binding,
  type ClaimTarget,
  type LocalLoad,
  type WorkspaceSpec,
} from '@musterd/protocol';
import { z } from 'zod';
import { parseClaimTarget } from './claim-client.js';
import { machineStatePath } from './machinePaths.js';
import { nodeFs } from './onboard/reconcile/context.js';
import { readLocalFile } from './onboard/reconcile/store.js';

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
  sessionLease?: string;
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
  const sessionLease = env['MUSTERD_SESSION_LEASE'];
  return {
    team,
    credential: {
      team,
      agentKey,
      target,
      ...(grant !== undefined ? { grant } : {}),
      ...(sessionLease !== undefined ? { sessionLease } : {}),
      // A CLI act is intrinsically `cli` (ADR 286) — env no longer chooses the Surface here. The
      // per-command `--surface` flag remains the deliberate manual override where one exists.
      surface: 'cli',
    },
  };
}

export interface Identity {
  name: string;
  /** The Bearer secret this identity authenticates with: agent-seat (`msac_`) or human (`mscr_`)
   * credential. The team agent key (`mskey_`) is only claim bootstrap authority. */
  key: string;
  surface: string;
  /** Required with an agent-seat credential: proof of its current Presence (ADR 337). */
  sessionLease?: string;
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
  /** Pre-ADR-281 registry rows recorded the declared surface; v2 identity has none. Read-only relic. */
  surface?: string;
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

/**
 * Recognize the version-1 identity shape (pre-ADR-281): otherwise valid, carries `surface`, has no
 * `version`. The old schemas were non-strict, so recognition parses loosely; a v1 file whose VALUES
 * are malformed is `invalid`, never `legacy` (ADR 282 §1). Recognition only — no dual read: nothing
 * outside a confirmed `musterd harness configure` may consume the value.
 */
const LegacyIdentitySchema = z.object({
  server: z.string(),
  team: z.string(),
  surface: z.string().min(1),
  claim: ClaimPolicySchema.optional(),
});

function isLegacyIdentity(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || 'version' in value) return false;
  return LegacyIdentitySchema.safeParse(value).success;
}

/** Classify `<dir>/.musterd/workspace.json` (ADR 282 `LocalLoad`): missing | legacy | valid | invalid. */
export function loadWorkspace(dir: string): LocalLoad<WorkspaceSpec> {
  return readLocalFile(nodeFs, join(dir, BINDING_DIR, WORKSPACE_SPEC_FILE), WorkspaceSpecSchema, {
    legacy: isLegacyIdentity,
  });
}

/** Classify `<dir>/.musterd/binding.json` (ADR 282 `LocalLoad`): missing | legacy | valid | invalid. */
export function loadBinding(dir: string): LocalLoad<Binding> {
  return readLocalFile(nodeFs, join(dir, BINDING_DIR, BINDING_FILE), BindingSchema, {
    legacy: isLegacyIdentity,
  });
}

/**
 * The team whose roster home this identity file sits in, or null.
 *
 * `config.rosterHome` is the registry the daemon and CLI already share (ADR 058) — this only asks
 * it. Wrapped in a try: a diagnostic must never become the failure it was explaining, so an
 * unreadable config falls back to the general wording rather than throwing over it.
 */
function rosterHomeTeamFor(identityPath: string): string | null {
  try {
    const dir = resolve(dirname(dirname(identityPath)));
    const entry = Object.entries(loadConfig().rosterHome).find(([, home]) => resolve(home) === dir);
    return entry ? entry[0] : null;
  } catch {
    return null;
  }
}

/** The repair diagnostic for a `legacy`/`invalid` local identity file — kind and schema issues
 *  only, never file contents or secrets (ADR 282). Exported so the strict identity consumers
 *  ({@link requireUsableBinding}, claim) refuse with the same words the advisory warning uses. */
export function identityRepairError(
  kind: 'legacy' | 'invalid',
  path: string,
  fileKind: string,
): Error {
  if (kind === 'legacy') {
    // A roster home is not an agent worktree and runs no harnesses. Measured 2026-08-24 on the live
    // revive roster home: the general wording called it "this workspace" and asked it to confirm a
    // harness set, while `rosterHome` already named the folder for what it is. The repair is the
    // same command with the answer supplied, because the empty set is the only right answer there.
    const rosterTeam = rosterHomeTeamFor(path);
    if (rosterTeam !== null) {
      return new Error(
        `${path} is a version-1 ${fileKind} (pre-ADR-281, it still carries "surface") — this ` +
          `folder is ${rosterTeam}'s roster home, not an agent worktree, so it runs no harnesses. ` +
          "Convert it with `musterd harness configure --select '' --yes` (the empty set).",
      );
    }
    return new Error(
      `${path} is a version-1 ${fileKind} (pre-ADR-281, it still carries "surface") — this ` +
        'workspace has no usable identity until it is converted. Run `musterd harness configure` ' +
        'here to confirm the desired harness set and convert it (headless: `musterd harness ' +
        'configure --select <ids> --yes`).',
    );
  }
  return new Error(
    `${path} exists but is not a readable ${fileKind} — this workspace has no usable identity ` +
      'until the file is repaired or re-provisioned (`musterd init`, or `musterd harness ' +
      'configure` for an existing worktree).',
  );
}

/** Paths already warned about, so a legacy/unreadable binding announces itself once rather than on
 *  every advisory read (several ride hooks and 60s supervisor ticks). */
const warnedUnusable = new Set<string>();

/**
 * `null` here has always meant two very different things — "no binding" and "a binding I could not
 * use" — and the second one is why #508 was silent for a full session. The ADR 282 landing swung
 * to the other extreme: the compat wrapper THREW on `legacy`/`invalid`, which took down every verb
 * that touched a binding it did not need — the ADR 293 streamwatch supervisor died every 60s on
 * `stream ensure`, whose binding read (`serverProvenance`'s disagreement diagnostic) is purely
 * advisory. So the split is by CONSUMER, not by file state: this advisory wrapper warns ONCE per
 * path on stderr (the full repair text) and returns null, while the identity consumers — the ones
 * that would act AS the binding — refuse hard via {@link requireUsableBinding}, so a broken
 * workspace never silently degrades to some other identity source.
 */
function readBinding(path: string): Binding | null {
  const got = readLocalFile(nodeFs, path, BindingSchema, { legacy: isLegacyIdentity });
  if (got.kind === 'missing') return null;
  if (got.kind === 'valid') return got.value;
  if (!warnedUnusable.has(path)) {
    warnedUnusable.add(path);
    console.error(`[musterd] ${identityRepairError(got.kind, path, 'workspace binding').message}`);
  }
  return null;
}

/**
 * The STRICT identity read (ADR 281/282): the binding this workspace would act as. `missing` → null
 * (a genuinely unbound folder), but `legacy`/`invalid` THROWS the repair — falling through to some
 * other identity source (env default, the global config vault) would have the workspace silently
 * act as a different member, which is worse than failing. Walks up from `startDir` like
 * {@link findBinding}; honours `MUSTERD_BINDING`.
 */
export function requireUsableBinding(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Binding | null {
  const explicit = env['MUSTERD_BINDING'];
  const path = explicit ?? findBindingPath(startDir);
  if (path === null) return null;
  const got = readLocalFile(nodeFs, path, BindingSchema, { legacy: isLegacyIdentity });
  if (got.kind === 'missing') return null;
  if (got.kind === 'valid') return got.value;
  const err = identityRepairError(got.kind, path, 'workspace binding');
  if (got.kind === 'invalid') {
    err.message += ` (${got.issues.map((i) => `${i.path}: ${i.message}`).join('; ')})`;
  }
  throw err;
}

/** The binding file an upward walk from `startDir` would read, or null when none exists. */
function findBindingPath(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const p = join(dir, BINDING_DIR, BINDING_FILE);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Non-throwing classification of the exact binding file — for writers that replace rather than
 *  read (the {@link saveBinding} merge-guard preserves fields only from a VALID on-disk file). */
function classifyBindingFile(path: string): Binding | null {
  const got = readLocalFile(nodeFs, path, BindingSchema, { legacy: isLegacyIdentity });
  return got.kind === 'valid' ? got.value : null;
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
      ...(cred.credential.sessionLease !== undefined
        ? { sessionLease: cred.credential.sessionLease }
        : {}),
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
 *   Omit still means preserve. An explicit `{ drop: { model_observed: true } }` is a different
 *   writer intent (ADR 268): the capture writer that learned the session id changed, and has no
 *   new observation, must not keep the previous session's model. Claim/agent never pass `drop`.
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
/** Capture-writer intent, distinct from omit. Claim/agent never pass this (ADR 268). */
export type SaveBindingOptions = { drop?: { model_observed?: boolean } };

export function saveBinding(dir: string, binding: Binding, opts?: SaveBindingOptions): string {
  const bindingDir = join(dir, BINDING_DIR);
  mkdirSync(bindingDir, { recursive: true });
  const p = join(bindingDir, BINDING_FILE);
  const onDisk = classifyBindingFile(p);
  const dropObserved = opts?.drop?.model_observed === true;
  let merged: Binding = {
    ...binding,
    ...(binding.session === undefined && onDisk?.session !== undefined
      ? { session: onDisk.session }
      : {}),
    ...(dropObserved
      ? {}
      : binding.model_observed === undefined && onDisk?.model_observed !== undefined
        ? { model_observed: onDisk.model_observed }
        : {}),
  };
  if (dropObserved && merged.model_observed !== undefined) {
    const { model_observed: _dropped, ...rest } = merged;
    merged = rest;
  }
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
 * clone/worktree self-wireable via `musterd wire`. Strict v2 (ADR 281): callers construct the exact
 * secret-free object — the schema REJECTS a stray `agent_key`/`grant`/runtime field instead of
 * stripping it, so a Binding can no longer be laundered into the committed file by parsing.
 */
export function saveWorkspaceSpec(dir: string, spec: WorkspaceSpec): string {
  const bindingDir = join(dir, BINDING_DIR);
  mkdirSync(bindingDir, { recursive: true });
  const p = join(bindingDir, WORKSPACE_SPEC_FILE);
  // Parse-then-write: a malformed or secret-carrying object throws here, before any byte moves.
  const safe = WorkspaceSpecSchema.parse(spec);
  writeFileSync(p, JSON.stringify(safe, null, 2) + '\n', 'utf8');
  return p;
}

/**
 * Locate + parse the committed workspace spec — the same `.musterd/workspace.json` the MCP adapter
 * falls back to, so the two surfaces can't drift. Walks up from `startDir` like {@link findBinding};
 * `missing` → null; a `legacy`/`invalid` file warns once on stderr (the configure repair) and reads
 * as null — this is an ADVISORY read, and the strict consumers classify via {@link loadWorkspace}.
 */
export function findWorkspaceSpec(startDir: string = process.cwd()): WorkspaceSpec | null {
  let dir = startDir;
  for (;;) {
    const p = join(dir, BINDING_DIR, WORKSPACE_SPEC_FILE);
    if (existsSync(p)) {
      const got = readLocalFile(nodeFs, p, WorkspaceSpecSchema, { legacy: isLegacyIdentity });
      if (got.kind === 'missing') return null;
      if (got.kind === 'valid') return got.value;
      // Advisory like readBinding: warn once with the repair, never kill the caller — the strict
      // consumers (wire, harness) classify via loadWorkspace themselves.
      if (!warnedUnusable.has(p)) {
        warnedUnusable.add(p);
        console.error(`[musterd] ${identityRepairError(got.kind, p, 'workspace spec').message}`);
      }
      return null;
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

/**
 * Snapshot taken at {@link loadConfig} time, keyed by the returned object. {@link saveConfig}
 * 3-way-merges against this so a caller that loaded, mutated one map, and saved does not drop
 * keys another process wrote in between (ADR 255). A Config constructed from scratch (reset)
 * has no snapshot — that write replaces.
 */
const loadedSnapshots = new WeakMap<Config, Config>();

function emptyConfig(): Config {
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

function readConfigFromDisk(): Config {
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
    return emptyConfig();
  }
}

export function loadConfig(): Config {
  const config = readConfigFromDisk();
  loadedSnapshots.set(config, structuredClone(config));
  return config;
}

/** Where a resolved server URL came from, in the order the resolution actually consults. */
export interface ServerProvenance {
  server: string;
  source: 'MUSTERD_SERVER' | 'machine default' | 'built-in default';
  /**
   * Set only when the folder is bound to a DIFFERENT daemon than the one resolved above — i.e. the
   * tool is about to report on a server this folder does not use.
   */
  disagreeingBinding?: { server: string; team: string };
}

/**
 * Name the server a machine-global reader is about to measure, and where it came from.
 *
 * `service status` and `stream doctor` both resolve from `loadConfig().server` and then report
 * without saying so. On 2026-08-12 that default had been repointed at a short-lived probe daemon by
 * a `team create` elsewhere on the machine, and both tools failed their checks correctly — about
 * the wrong port. The cost was in the diagnosis, not the failure: every reader is confidently wrong
 * in the SAME direction, because the output is indistinguishable from infrastructure being down.
 *
 * `disagreeingBinding` is the line that would have ended it in seconds. A binding outranks the
 * global default everywhere identity is resolved, so a folder bound to :4849 while this reader
 * measures :4899 is not a subtle inconsistency — it is the whole diagnosis, printed.
 */
export function serverProvenance(dir: string = process.cwd()): ServerProvenance {
  const config = loadConfig();
  const fromEnv = process.env['MUSTERD_SERVER'];
  const onDisk = readServerFromDiskRaw();
  const source: ServerProvenance['source'] = fromEnv
    ? 'MUSTERD_SERVER'
    : onDisk
      ? 'machine default'
      : 'built-in default';
  const binding = findBinding(dir);
  return {
    server: config.server,
    source,
    ...(binding && binding.server !== config.server
      ? { disagreeingBinding: { server: binding.server, team: binding.team } }
      : {}),
  };
}

/** The `server` literally stored in the config file — `undefined` when the file is absent, unreadable,
 *  or simply never wrote one. Distinguishes "someone set this machine's default" from the built-in. */
function readServerFromDiskRaw(): string | undefined {
  try {
    return (JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<Config>).server;
  } catch {
    return undefined;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeMap<V>(
  base: Record<string, V>,
  ours: Record<string, V>,
  disk: Record<string, V>,
): Record<string, V> {
  const result: Record<string, V> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(disk)]);
  for (const k of keys) {
    const inBase = Object.hasOwn(base, k);
    const inOurs = Object.hasOwn(ours, k);
    const inDisk = Object.hasOwn(disk, k);
    if (inOurs && !inBase) {
      result[k] = ours[k]!;
    } else if (inBase && !inOurs) {
      // we deleted it — omit even if disk still has it
    } else if (inOurs && inBase) {
      if (!sameJson(ours[k], base[k])) result[k] = ours[k]!;
      else if (inDisk) result[k] = disk[k]!;
    } else if (inDisk) {
      result[k] = disk[k]!;
    }
  }
  return result;
}

function vaultKey(si: StoredIdentity): string {
  return `${si.team}\0${si.name}`;
}

function vaultToMap(list: StoredIdentity[]): Record<string, StoredIdentity> {
  return Object.fromEntries(list.map((si) => [vaultKey(si), si]));
}

function mergeScalar<T>(base: T, ours: T, disk: T): T {
  return sameJson(ours, base) ? disk : ours;
}

function threeWayMerge(base: Config, ours: Config, disk: Config): Config {
  const current = mergeScalar(base.current, ours.current, disk.current);
  return {
    server: mergeScalar(base.server, ours.server, disk.server),
    ...(current !== undefined ? { current } : {}),
    identities: mergeMap(base.identities, ours.identities, disk.identities),
    knownIdentities: Object.values(
      mergeMap(
        vaultToMap(base.knownIdentities),
        vaultToMap(ours.knownIdentities),
        vaultToMap(disk.knownIdentities),
      ),
    ),
    bindings: mergeMap(base.bindings, ours.bindings, disk.bindings),
    agentKeys: mergeMap(base.agentKeys, ours.agentKeys, disk.agentKeys),
    rosterHome: mergeMap(base.rosterHome, ours.rosterHome, disk.rosterHome),
    teamHome: mergeMap(base.teamHome, ours.teamHome, disk.teamHome),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isEexist(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

const LOCK_WAIT_MS = 20;
const LOCK_DEADLINE_MS = 5_000;
let configLockDepth = 0;

function acquireConfigLock(lockPath: string): void {
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', encoding: 'utf8' });
      return;
    } catch (err) {
      if (!isEexist(err)) throw err;
      let stale = false;
      try {
        const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
        stale = !Number.isInteger(pid) || pid === process.pid || !pidAlive(pid);
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // raced with another stealer
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${lockPath}`);
      }
      Atomics.wait(sleeper, 0, 0, LOCK_WAIT_MS);
    }
  }
}

function withConfigLock<T>(fn: () => T): T {
  const lockPath = `${configPath()}.lock`;
  if (configLockDepth === 0) acquireConfigLock(lockPath);
  configLockDepth++;
  try {
    return fn();
  } finally {
    configLockDepth--;
    if (configLockDepth === 0) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // already gone
      }
    }
  }
}

function writeConfigAtomic(config: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
  renameSync(tmp, p);
}

/**
 * Persist the global config. Callers that {@link loadConfig}'d, mutated, and save the same object
 * 3-way-merge with disk under an exclusive lock so concurrent CLI processes cannot drop each
 * other's identities, bindings, or vault entries (ADR 255). A Config built from scratch (reset)
 * has no load snapshot and replaces the file.
 */
export function saveConfig(config: Config): void {
  withConfigLock(() => {
    const base = loadedSnapshots.get(config);
    const merged = base ? threeWayMerge(base, config, readConfigFromDisk()) : config;
    writeConfigAtomic(merged);
    loadedSnapshots.set(config, structuredClone(merged));
  });
}

/** Derive the WS base URL from the HTTP server URL. */
export function wsBase(server: string): string {
  return server.replace(/^http/, 'ws');
}
