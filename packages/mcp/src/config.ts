import { createHash } from 'node:crypto';
import {
  type Capabilities,
  FEATURE_EPOCH,
  parseClaimPolicy,
  SURFACES,
  type ClaimPolicy,
  type Provenance,
  resolveAttestation,
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
import { resolveDriver, resolveModel, resolveProvenance, resolveWorkspace } from './workspace.js';

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
  /**
   * The **resolved** seat, once this session has occupied one (set from the `occupied` frame). A session
   * starts unclaimed (undefined ⇒ pending presence: reachable, holding no seat) and fills this in when it
   * claims (`team_join` / an external `musterd claim`); a role pool resolves its `<role>-<n>` here.
   */
  member?: string | undefined;
  /** Optional pre-issued grant (`msgr_`) that skips the pending/admin-approval lane (ADR 075). */
  grant?: string | undefined;
  surface: Surface;
  /** Why this session attaches (provenance/where seed, ADR 014). Defaults to `session`. */
  provenance: Provenance;
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

/**
 * **Surface drift.** The harness a seat *declares* contradicted by the one that actually ran.
 *
 * `surface` resolves `env > binding.json > committed workspace.json` and is then simply believed.
 * `model` outgrew that — ADR 158 gave it an observation path that corrects it at the tool boundary —
 * and surface was left on whatever declaration it was born with. It is not cosmetic: it labels every
 * presence row, every audit entry, and the roster, all of which present it as fact.
 *
 * A capture in the binding is the evidence the declaration lacks. Hooks are harness-specific by
 * construction — the Claude Code capture writes `harness: 'claude-code'`, the Cursor hook writes
 * `'cursor'` — so a capture is proof that harness ran *here*. Measured across eleven seat worktrees
 * on 2026-08-03, exactly one disagreed: a seat declaring `cursor` whose session and model observation
 * were both written by `claude-code`, from a `MUSTERD_SURFACE` baked into a pre-ADR-165
 * `.cursor/mcp.json` — the top of the ladder, where nothing can correct it.
 *
 * This warns; it deliberately does not re-rank. Promoting the observation above `binding` would not
 * even fix the measured seat (its stale value is in `env`, a rung higher), and promoting it above
 * `env` would break the documented manual override. Whatever order you pick, a baked value at the
 * top can still lie — so make the contradiction visible rather than re-rank the liars.
 *
 * Silent unless something was actually captured: a declaration alone is not a contradiction, and
 * Codex has no hook path at all, so warning on absence would fire forever on every Codex seat.
 *
 * **The prescription is deliberately narrower than the warning.** This warning used to prescribe
 * `musterd wire` (env case) and `musterd agent <seat>` (binding case). Both of those re-provision:
 * they call `harness.configure`, which does `claude mcp remove musterd -s local` + `add` — and
 * Claude Code keys local scope by **repo root**, so that slot is shared by every `agents-*` seat
 * worktree of this repo (ADR 143). Repairing one stale string in one seat's gitignored binding
 * therefore rewrote the entry every seat on the machine launches through, re-pointing its
 * `command`/`args` at whatever checkout the running CLI resolved, and reinstalled hooks besides.
 * That is a machine-wide write to fix a per-worktree field, and it is how a warning grew a
 * machine-wide repair without anyone reviewing it: the seven tests here all covered *detection*
 * and none covered what the message told the reader to do.
 *
 * So the fix named here touches only the file that holds the stale value: one `-e` in the harness's
 * own MCP entry, or one field in this worktree's `.musterd/binding.json`. A too-wide write is not
 * closed with another too-wide write. `packages/mcp/src/surface-drift.test.ts` binds this — including
 * a guard that fails if a fourth command learns to rewrite the shared entry.
 */
function warnContestedSurface(
  claim: ClaimPolicy,
  surface: Surface,
  binding: ReturnType<typeof findBinding>,
  fromEnv: boolean,
): void {
  if (claim.mode !== 'seat' || !binding) return;
  // Either capture is the same class of evidence — a hook of that harness fired in this workspace.
  // The session is preferred: it is the harness running *now*, where the observation may predate a
  // switch. `?? undefined` because a binding read from disk may carry neither.
  const ran = binding.session?.harness ?? binding.model_observed?.harness;
  if (!ran || ran === surface) return;
  const source = fromEnv
    ? `MUSTERD_SURFACE=${surface} in this harness's MCP entry (a baked value outranks binding.json and ` +
      `no observation can correct it — delete that one \`-e MUSTERD_SURFACE=\` from the entry)`
    : `"surface": "${surface}" in .musterd/binding.json — set it to "${ran}" (this worktree only)`;
  console.error(
    `[musterd] seat "${claim.name}" reports surface "${surface}", but the session in this workspace ` +
      `was captured by "${ran}" — a ${ran} hook only fires under ${ran}, so the declaration is the ` +
      `stale one. It is what the roster, presence and audit will say this seat is running. ` +
      `Fix: ${source}.`,
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
 * surface, claim) the ladder is `env > binding.json > workspace.json`. The committed `workspace.json`
 * is the lowest-precedence base, so a fresh clone whose only musterd file is that spec (plus an
 * env-supplied `MUSTERD_AGENT_KEY`) still resolves its identity. Secrets (`agent_key`, `grant`) are
 * **never** read from the spec — only env or the gitignored binding.json.
 */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const binding = findBinding(process.cwd(), env);
  const spec = findWorkspaceSpec(process.cwd(), env);
  const server =
    env['MUSTERD_SERVER'] ?? binding?.server ?? spec?.server ?? 'http://localhost:4849';
  const team = env['MUSTERD_TEAM'] ?? binding?.team ?? spec?.team;
  // v0.3 (ADR 075): the auth secret is the team agent key; the seat is resolved at claim time (the
  // `occupied` frame), so `member` starts undefined — the target lives in the claim policy below.
  // agent_key/grant are secrets → env or binding.json only, NEVER the committed spec.
  const agentKey = env['MUSTERD_AGENT_KEY'] ?? binding?.agent_key;
  const grant = env['MUSTERD_GRANT'] ?? binding?.grant;
  const surfaceRaw = env['MUSTERD_SURFACE'] ?? binding?.surface ?? spec?.surface ?? 'other';
  if (!team) {
    throw new Error('musterd MCP: no team — set MUSTERD_TEAM or provide a .musterd/binding.json');
  }
  const surface = (SURFACES as readonly string[]).includes(surfaceRaw)
    ? (surfaceRaw as Surface)
    : 'other';
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
  warnContestedSurface(claim, surface, binding, env['MUSTERD_SURFACE'] !== undefined);
  // A seat-mode session gets a stable disambiguation code (ADR 087) keyed by what makes it the same
  // seat across relaunches: team + workspace + seat name + surface. Role/chat sessions keep a fresh
  // per-process code (see shortCode). `connId` stays a fresh ulid — it's the transport/hub identity and
  // must be unique per live socket; the collapse-by-seat request dedup already handles its churn.
  const codeSeed =
    claim.mode === 'seat' ? [team, workspace, claim.name, surface].join('\0') : undefined;
  const bindingDir = resolveBindingDir(process.cwd(), env);
  // ADR 213 — reverse of ADR 143: binary under seat A, identity under seat B.
  warnForeignAdapterWorkspace(import.meta.url, bindingDir);
  return {
    server,
    team,
    ...(agentKey !== undefined ? { agent_key: agentKey } : {}),
    ...(grant !== undefined ? { grant } : {}),
    surface,
    provenance: resolveProvenance(env),
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
 * Re-resolve the attested model from the binding on disk, mutating `config` in place. Returns true
 * when the attested model actually changed.
 *
 * The other half of the ADR 158 follow-up. The hook-side refresh corrects `binding.model_observed`
 * mid-session, but the adapter resolved its attestation once, in `main()`, at a moment when the
 * transcript was still empty — so a corrected observation sat on disk while the roster kept
 * reporting the boot-time value for the entire session. Measured on seat `ryder`: `binding.json`
 * read `claude-opus-5` and the roster read `claude-opus-4-8` at the same instant.
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
