import { createHash } from 'node:crypto';
import {
  type Capabilities,
  FEATURE_EPOCH,
  parseClaimPolicy,
  SurfaceSchema,
  type ClaimPolicy,
  type Provenance,
  resolveAttestation,
  resolveAttestedProvenance,
  type Surface,
} from '@musterd/protocol';
import { readBuildStamp } from '@musterd/protocol/build-stamp';
import { ulid } from 'ulid';
import {
  findBinding,
  findWorkspaceSpec,
  resolveBindingDir,
  warnForeignAdapterWorkspace,
} from './binding.js';
import { readWakeLeaseFile } from './wakeLeaseFile.js';
import {
  resolveDriver,
  resolveModel,
  resolveProvenance,
  resolveWakeLease,
  resolveWorkspace,
} from './workspace.js';

/**
 * Where this adapter obtained its model. `observed` (a harness probe, hook-written) outranks both
 * declarations, because a declaration is a snapshot and snapshots rot. `unknown` remains legal and
 * warn-only.
 */
export type ModelSource = 'observed' | 'environment' | 'binding' | 'unknown';

export interface McpConfig {
  server: string;
  team: string;
  /**
   * v0.3 (ADR 075): the team **agent key** (`mskey_`) or human credential this session authenticates
   * with — the Bearer secret + what the `claim` frame presents. From `MUSTERD_AGENT_KEY` / the binding.
   */
  agent_key?: string | undefined;
  /** Per-agent self-identifying HTTP credential, minted at first authorized occupancy (ADR 337). */
  seatCredential?: string | undefined;
  /** Short-lived lease for the current agent Presence, refreshed by each successful claim (ADR 337). */
  sessionLease?: string | undefined;
  /**
   * The **resolved** seat, once this session has occupied one (set from the `occupied` frame). A session
   * starts unclaimed (undefined ⇒ pending presence: reachable, holding no seat) and fills this in when it
   * claims (`team_join` / an external `musterd claim`); a role pool resolves its `<role>-<n>` here.
   */
  member?: string | undefined;
  /** Optional pre-issued grant (`msgr_`) that skips the pending/admin-approval lane (ADR 075). */
  grant?: string | undefined;
  surface: Surface;
  /** Which launcher marker resolved `surface` (ADR 286) — telemetry-recorded, never env contents. */
  markerGeneration: MarkerGeneration;
  /** Why this session attaches (provenance/where seed, ADR 014). Defaults to `session`. */
  provenance: Provenance;
  /** The wake lease that spawned this session (ADR 241), from `MUSTERD_WAKE_LEASE`. Undefined for
   *  every session no wake caused — and it must stay undefined rather than defaulting, because the
   *  host reads a match as proof it spawned this session. */
  wakeLease?: string | undefined;
  /** The gracefully-degrading "where" label, resolved once at load. */
  workspace: string;
  /** The human driving this session, if one is (driver co-presence, ADR 021). Env > binding.json
   *  (ADR 165 inc 2) — per-worktree state, never the repo-root-shared harness entry. */
  driver?: string | undefined;
  /** Join-on-launch (ADR 032/165): should a session with a concrete identity `join()` immediately?
   *  `MUSTERD_AUTOJOIN` env wins ('1' on, anything else off — an explicit off must beat the binding),
   *  else `binding.autojoin`, else false (dormant until an explicit join). */
  autojoin: boolean;
  /** Harness-attested model id for this occupancy (ADR 101). Attested, never verified; absent ⇒
   *  the server renders `unknown` and never blocks. */
  model?: string | undefined;
  /** The tier that supplied `model`, never inferred from MCP `clientInfo` (ADR 120). */
  modelSource: ModelSource;
  /** Set when an observation contradicted a declaration — the tripwire signal. Never blocks. */
  modelDrift?: { declared: string; observed: string } | undefined;
  /** The seat's effective capabilities as of its last occupy (ADR 144 inc 5), read from
   *  `binding.capabilities` at load and refreshed in place when this session occupies. Scopes the
   *  rendered tool surface; absent ⇒ the full surface (fail-open — see `scope.ts`). */
  capabilities?: Capabilities | undefined;
  /**
   * This adapter dist's own build ref (ADR 135) — the `dist/build.json` stamp read once at load, so
   * the *running process* reports the code it booted with (a rebuilt dist under a live session still
   * attests the old ref until `/mcp` reload — exactly the staleness the skew warning surfaces).
   * Undefined for unstamped builds; every consumer degrades to silence.
   */
  build?: string | undefined;
  /** This adapter's feature epoch (ADR 148) — a compiled-in constant, so it always attests. The roster
   *  uses it (not the build ref) as the visible skew signal: a seat behind the daemon's epoch lacks
   *  later features. Fixed at build time, so no back-compat guard is needed on our own clients. */
  epoch: number;
  /** Folder claim policy (ADR 018 ladder) — what `team_join {}` / autojoin does by default. */
  claim: ClaimPolicy;
  /** Per-session connection id (the pending-presence key tuple, ADR 033). */
  connId: string;
  /** Short, human-typable disambiguation code for `musterd claim --for <code>` (ADR 033). */
  claimCode: string;
  /**
   * The workspace directory this session's identity is anchored to (the `.musterd/` that seeded this
   * config). A claim persists the resolved seat *here*, never to ambient `process.cwd()` — so an
   * adapter whose cwd wandered into a sibling worktree can't clobber that worktree's binding.json.
   */
  bindingDir: string;
}

/** Crockford-ish uppercase alphabet (no I/L/O/U) for a human-typable, unambiguous disambiguation code. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

/**
 * A short, human-typable disambiguation code (uppercase) for `musterd claim --for <code>`.
 *
 * With a `seed` (a seat-mode session) the code is a **stable** hash of that seed — the same folder +
 * seat yields the same code across process restarts, so a reconnect doesn't orphan an in-flight
 * approval or invalidate the `--for <code>` an admin was told to approve (ADR 087, root cause 2).
 * Without a seed (role/chat — no fixed seat, and one folder may host several such sessions) it stays a
 * fresh per-process ulid slice, keeping concurrent pending presences distinguishable.
 */
function shortCode(seed?: string): string {
  if (seed === undefined) return ulid().slice(-4).toUpperCase();
  const digest = createHash('sha256').update(seed).digest();
  let out = '';
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[digest[i]! % CODE_ALPHABET.length];
  return out;
}

/**
 * **The attestation gap.** A seat that resolves an identity but no model occupies, works, and ships
 * while attesting nothing — and until this warning, did so in silence.
 *
 * Two ladders, each individually right, disagree about how many rungs they have:
 *
 *   identity  =  env  >  binding.json  >  committed workspace.json
 *   model     =  env  >  binding.json
 *
 * The spec carries no model on purpose (a model is a per-machine fact, not one everybody who clones
 * inherits) and ADR 165 stopped provisioning baking `MUSTERD_MODEL` on purpose (a snapshot at the top
 * of the ladder rots, and outranks every later correction — one seat attested `grok-4.5` for weeks).
 * Both stand. But a seat whose identity comes from the third source falls off the model ladder, and
 * the cost is not "one field is empty": ADR 158 refuses an acceptor whose diversity claim cannot be
 * proven, so the seat is dropped from every review pool, from the ADR 056 diversity conclusion, and
 * from the per-model loop-closure telemetry — silently, while looking perfectly healthy.
 *
 * Measured 2026-08-01: a seat worked and shipped PRs all day like this, and reading the presence
 * table directly was the only way to find out. So: say it, at the moment it happens, by name.
 *
 * stderr, never stdout — stdout is the MCP stdio transport. Never throws: an unattested seat is
 * degraded, not broken, and refusing to boot over it would trade a quiet hole for a dead seat.
 */
function warnUnattestedSeat(
  claim: ClaimPolicy,
  model: string | undefined,
  hasBinding: boolean,
): void {
  // Seats only. A chat-mode session holds no seat, so it grades nothing and reviews nothing —
  // warning there would just train the reader to ignore the warning that matters.
  if (claim.mode !== 'seat' || model !== undefined) return;
  const fix = hasBinding
    ? `add "model" to this workspace's .musterd/binding.json (or \`musterd agent ${claim.name} --model <id>\`)`
    : `this workspace has no .musterd/binding.json — its identity came from the committed workspace.json, which carries no model by design; run \`musterd agent ${claim.name}\` here, or set MUSTERD_MODEL`;
  console.error(
    `[musterd] seat "${claim.name}" is attesting no model. It will still work, but musterd cannot ` +
      `prove what it is running, so it is excluded from every diversity decision (ADR 158) and ` +
      `missing from the model telemetry rather than counted as unknown. Fix: ${fix}.`,
  );
}

function asSurface(value: string | undefined): Surface | undefined {
  if (value === undefined) return undefined;
  return SurfaceSchema.safeParse(value).success ? (value as Surface) : undefined;
}

/** Which marker generation resolved this session's Surface (recorded in telemetry, ADR 286).
 *  `native` is the in-process host (ADR 251): it constructs its config itself, no marker involved. */
export type MarkerGeneration = 'launch' | 'test-override' | 'native';

/**
 * Runtime Surface comes from the LAUNCHER, and only the launcher (ADR 286). Resolution is
 * `MUSTERD_TEST_SURFACE` (deliberate headless/testing override) first, then
 * `MUSTERD_LAUNCH_SURFACE` (what a fragment-managed registration writes). Nothing else: no
 * binding/spec fallback, no capture inference, and any presence of the retired `MUSTERD_SURFACE`
 * refuses even beside a valid marker — a registration still carrying it predates the conversion
 * and must go through a confirmed `musterd harness configure`, never a dual-read path.
 *
 * Refusal throws: an external adapter that cannot say what launched it must not attach Presence.
 * The error names the repair. Env contents are never logged — only which marker was present.
 */
export function resolveLaunchSurface(env: NodeJS.ProcessEnv): {
  surface: Surface;
  markerGeneration: MarkerGeneration;
} {
  if (env['MUSTERD_SURFACE'] !== undefined) {
    throw new Error(
      'musterd MCP: this registration still sets the retired MUSTERD_SURFACE marker (pre-ADR-286) — ' +
        'it is never consulted and refuses Presence attachment. Run `musterd harness configure` in ' +
        'this worktree to convert the registration, then reload the session.',
    );
  }
  const test = env['MUSTERD_TEST_SURFACE'];
  if (test !== undefined) {
    const surface = asSurface(test);
    if (!surface) {
      throw new Error(
        'musterd MCP: MUSTERD_TEST_SURFACE is set but not a valid Surface — fix or unset it.',
      );
    }
    return { surface, markerGeneration: 'test-override' };
  }
  const launch = env['MUSTERD_LAUNCH_SURFACE'];
  if (launch !== undefined) {
    const surface = asSurface(launch);
    if (!surface) {
      throw new Error(
        'musterd MCP: MUSTERD_LAUNCH_SURFACE is set but not a valid Surface — re-run `musterd ' +
          'harness configure` to rewrite this registration.',
      );
    }
    return { surface, markerGeneration: 'launch' };
  }
  throw new Error(
    'musterd MCP: no launch Surface marker — this registration predates ADR 286, so the adapter ' +
      'cannot say what launched it and refuses Presence attachment. Run `musterd harness ' +
      'configure` in this worktree to convert the registration (headless tests may set ' +
      'MUSTERD_TEST_SURFACE instead), then reload the session.',
  );
}

/**
 * Read + validate the MCP server's identity binding (05-mcp.md). Aligned with the CLI (ADR 018):
 * `MUSTERD_*` env wins (the host-injection contract / hosted setups with no writable fs), then the
 * workspace `.musterd/binding.json` — the same file the CLI reads, so the two can't drift.
 *
 * Claim-on-first-use (ADR 032): identity is now **optional**. A binding may carry only a claim
 * policy; the session then starts as a pending presence and claims a seat on first use. Only the
 * team (and server) are required to load.
 *
 * Committed launch spec (ADR: committed launch spec): for the **non-secret** fields (server, team,
 * surface, claim) the ladder is `env > binding.json > workspace.json`. Occupancy surface then
 * follows capture (ADR 275) unless `MUSTERD_SURFACE` or native `musterd`. The committed
 * `workspace.json` is the lowest-precedence base, so a fresh clone whose only musterd file is that
 * spec (plus an env-supplied `MUSTERD_AGENT_KEY`) still resolves its identity. Secrets (`agent_key`,
 * `grant`) are **never** read from the spec — only env or the gitignored binding.json.
 */
/** Test seams for the wake-lease file fallback (ADR 354); production reads the real clock and pid. */
export interface LoadMcpConfigDeps {
  now?: () => number;
  ppid?: () => number;
}

export function loadMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  deps: LoadMcpConfigDeps = {},
): McpConfig {
  const binding = findBinding(process.cwd(), env);
  const spec = findWorkspaceSpec(process.cwd(), env);
  const server =
    env['MUSTERD_SERVER'] ?? binding?.server ?? spec?.server ?? 'http://localhost:4849';
  const team = env['MUSTERD_TEAM'] ?? binding?.team ?? spec?.team;
  // v0.3 (ADR 075): the auth secret is the team agent key; the seat is resolved at claim time (the
  // `occupied` frame), so `member` starts undefined — the target lives in the claim policy below.
  // agent_key/grant are secrets → env or binding.json only, NEVER the committed spec.
  const agentKey = env['MUSTERD_AGENT_KEY'] ?? binding?.agent_key;
  const seatCredential = binding?.seat_credential;
  const sessionLease = binding?.session_lease;
  const grant = env['MUSTERD_GRANT'] ?? binding?.grant;
  if (!team) {
    throw new Error('musterd MCP: no team — set MUSTERD_TEAM or provide a .musterd/binding.json');
  }
  // ADR 286: Surface is resolved ONCE, at startup, from the launcher's explicit marker. No stored
  // file, capture, or observation participates; absence or the retired marker refuses (throws).
  const { surface, markerGeneration } = resolveLaunchSurface(env);
  // Claim policy: env wins (the ADR 018 ladder), else binding.json, else the committed spec, else chat.
  const claim: ClaimPolicy =
    env['MUSTERD_CLAIM'] !== undefined
      ? parseClaimPolicy(env['MUSTERD_CLAIM'])
      : (binding?.claim ?? spec?.claim ?? { mode: 'chat' });
  const workspace = resolveWorkspace(env);
  // Attestation, ordered by KIND of claim: an observation (what the harness was seen running, written
  // by the session-capture hooks) outranks any declaration; env still beats binding.json within the
  // declared tier. This inverts the defect where a wire-time snapshot baked into the env sat above
  // every later observation and could never be corrected.
  //
  // Boot-time value only — at adapter boot the session's transcript has no assistant turn yet, so
  // this usually resolves to a declaration or a previous session's observation. `refreshAttestation`
  // is what makes it true; see there.
  const attestation = attestationFor(binding, env);
  warnUnattestedSeat(claim, attestation.model, binding !== null);
  // A seat-mode session gets a stable disambiguation code (ADR 087) keyed by what makes it the same
  // seat across relaunches: team + workspace + seat name + surface. Role/chat sessions keep a fresh
  // per-process code (see shortCode). `connId` stays a fresh ulid — it's the transport/hub identity and
  // must be unique per live socket; the collapse-by-seat request dedup already handles its churn.
  const codeSeed =
    claim.mode === 'seat' ? [team, workspace, claim.name, surface].join('\0') : undefined;
  const bindingDir = resolveBindingDir(process.cwd(), env);
  // ADR 213 — reverse of ADR 143: binary under seat A, identity under seat B.
  warnForeignAdapterWorkspace(import.meta.url, bindingDir);
  // ADR 354: the wake-lease FILE is consulted only when the env is silent on BOTH provenance and
  // lease — env always wins, so a harness that forwards it (Claude Code) never reaches this line.
  // Codex launches MCP servers with a sanitized env (measured 2026-09-02: twelve variables, no
  // `MUSTERD_*`), so on that harness this is the only way the adapter can learn it was woken, and
  // without it the actuator read its own session as "held by another" and killed it. The reader
  // honours the file only from the process the actuator spawned (spawner_pid === our ppid) and only
  // while unexpired — an attestation with a source, never a default (ADR 236).
  const envSilent =
    resolveAttestedProvenance(env) === undefined && resolveWakeLease(env) === undefined;
  const fromFile = envSilent
    ? readWakeLeaseFile(bindingDir, {
        now: deps.now?.() ?? Date.now(),
        ppid: deps.ppid?.() ?? process.ppid,
      })
    : undefined;
  return {
    server,
    team,
    ...(agentKey !== undefined ? { agent_key: agentKey } : {}),
    ...(seatCredential !== undefined ? { seatCredential } : {}),
    ...(sessionLease !== undefined ? { sessionLease } : {}),
    ...(grant !== undefined ? { grant } : {}),
    surface,
    markerGeneration,
    provenance: fromFile ? 'wake' : resolveProvenance(env),
    wakeLease: resolveWakeLease(env) ?? fromFile?.lease_id,
    workspace,
    // Per-worktree fields moved out of the shared harness entry (ADR 165 inc 2): env stays the
    // manual override (headless/CI), the binding is what provisioning writes.
    driver: resolveDriver(env) ?? binding?.driver,
    autojoin:
      env['MUSTERD_AUTOJOIN'] !== undefined
        ? env['MUSTERD_AUTOJOIN'] === '1'
        : (binding?.autojoin ?? false),
    // Last occupy's resolved capabilities (ADR 144 inc 5) — binding-only, like `model`: never from
    // the committed spec, because a seat's authority is per-seat, not shared by everyone who clones.
    ...(binding?.capabilities ? { capabilities: binding.capabilities } : {}),
    // Never from the committed spec (a model is a per-machine choice, not shared). Absent ⇒ `unknown`.
    model: attestation.model,
    modelSource: attestation.source,
    ...(attestation.drift && attestation.declared !== undefined && attestation.model !== undefined
      ? { modelDrift: { declared: attestation.declared, observed: attestation.model } }
      : {}),
    build: readBuildStamp(import.meta.url),
    epoch: FEATURE_EPOCH,
    claim,
    connId: ulid(),
    claimCode: shortCode(codeSeed),
    bindingDir,
  };
}

/** The attestation ladder, shared by the boot resolve and the live refresh so the two cannot drift. */
function attestationFor(
  binding: ReturnType<typeof findBinding>,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof resolveAttestation> {
  return resolveAttestation({
    observed: binding?.model_observed,
    env: resolveModel(env),
    binding: binding?.model,
  });
}

/**
 * Re-resolve the attested model **and occupancy surface** from the binding on disk, mutating
 * `config` in place. Returns true when the attested model actually changed (surface updates are
 * silent on that flag — the heartbeat always re-sends `config.surface`).
 *
 * The other half of the ADR 158 follow-up. The hook-side refresh corrects `binding.model_observed`
 * mid-session, but the adapter resolved its attestation once, in `main()`, at a moment when the
 * transcript was still empty — so a corrected observation sat on disk while the roster kept
 * reporting the boot-time value for the entire session. Measured on seat `ryder`: `binding.json`
 * read `claude-opus-5` and the roster read `claude-opus-4-8` at the same instant.
 * ADR 270: the claim/heartbeat caller runs `reconcileCursorCapture` first, so a hookless
 * cursor-agent occupancy has something on disk to re-read.
 * ADR 275: the same re-read updates `config.surface` from the slot (unless `MUSTERD_SURFACE` or
 * native `musterd`), so a mid-session heal does not keep sending the claim-time declaration.
 *
 * Rides the 15s heartbeat, which already re-affirms the model precisely so "a mid-occupancy switch
 * or an attestation the claim missed lands without a reconnect" (ADR 101) — that path was correct
 * all along and merely had nothing new to say. The server no-ops an unchanged model, so a steady
 * session costs one small JSON read per heartbeat and no wire churn.
 *
 * Never throws: an unreadable binding leaves the existing attestation exactly as it stands.
 */
export function refreshAttestation(
  config: McpConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const binding = findBinding(config.bindingDir ?? process.cwd(), env);
    // ADR 286: a binding refresh may update model/capture/capability fields but NEVER
    // `config.surface` — runtime Surface was resolved once, from the launcher, at startup.
    const next = attestationFor(binding, env);
    // Never trade a real attestation for `unknown`: a binding that momentarily fails to read must
    // not blank the roster. Same never-erase rule the observation itself follows.
    if (next.model === undefined) return false;
    if (next.model === config.model && next.source === config.modelSource) return false;
    config.model = next.model;
    config.modelSource = next.source;
    if (next.drift && next.declared !== undefined) {
      config.modelDrift = { declared: next.declared, observed: next.model };
    } else {
      delete config.modelDrift;
    }
    return true;
  } catch {
    return false;
  }
}

/** Does this session already hold a seat (it has occupied one — the resolved `member` is set)? */
export function isClaimedConfig(config: McpConfig): boolean {
  return Boolean(config.member);
}
