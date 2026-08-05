import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { resolveWorkspace } from '@musterd/mcp';
import {
  GUIDANCE_CONTENT_VERSION,
  bindingSeat,
  formatClaimPolicy,
  parseContentStamp,
  TOKEN_PREFIXES,
  type Binding,
} from '@musterd/protocol';
import { HttpClient } from '../client.js';
import { harnessWiredFor, wireConfigures } from '../commands/wire.js';
import { findBinding, findWorkspaceSpec, loadConfig } from '../config.js';
import { inspectWakeMusterd } from '../host/pinnedBin.js';
import { theme } from '../render/theme.js';
import { packagedInstallNotes } from '../runtime.js';
import { cliBuild } from '../version.js';
import { foreignAdapterNote, primaryCheckoutFor, siblingWorkspaces } from './entryGuard.js';
import { contentHash, establishedHarnesses, guidanceTargets, strippedBody } from './guidance.js';
import type { Harness } from './harness.js';
import { inspectClaudeHookDrift } from './harnesses/claudeCode.js';
import { HARNESSES } from './harnesses/index.js';
import { readProvisionManifest } from './manifest.js';
import { classifyPrimerTarget } from './primer.js';

/**
 * `musterd init --check` — provisioning drift detector (ADR 060). A read-only checker, never a
 * writer (the `arch-trees:check` / `fmt --check` philosophy): it reports whether this folder is
 * coherently provisioned and exits non-zero on drift, so a re-run of init is idempotent and a stale
 * setup is *visible* instead of silent.
 *
 * The drift it exists to catch: the SessionStart hook keys off the committed `AGENTS.md` primer
 * marker (which travels with the repo), but the MCP-server registration lives in the harness's
 * machine-local config (`claude mcp add -s local`, never committed). On a checkout where the marker
 * is present but no `claude mcp add` ran, the hook tells an agent it's auto-joined while the `team_*`
 * tools are absent — exactly the mismatch this surfaces. (Same gap the smarter SessionStart hook now
 * guards at session start; this is the on-demand half.)
 */

/** One harness's provisioning state in this folder. */
interface HarnessState {
  label: string;
  installed: boolean;
  configured: boolean;
  detail?: string;
}

export interface DoctorReport {
  /** Does AGENTS.md carry the managed musterd primer (the hook's trigger)? */
  primerManaged: boolean;
  harnesses: HarnessState[];
  /** Actionable drift lines (empty ⇒ healthy). Exit-1. */
  drift: string[];
  /**
   * How this drift can be repaired, when there is any. `'wire'` ⇒ every line is *entry* drift: the
   * harness MCP entry disagrees with `.musterd/binding.json`, which `musterd wire` rewrites headlessly.
   * `'init'` ⇒ at least one line needs full onboarding (a missing primer, missing hooks, stale
   * guidance). Absent ⇒ no drift.
   *
   * This exists so `--fix` can stop prescribing `musterd init` for entry drift. On a repo-root-shared
   * entry (ADR 143) that remedy is actively harmful: it repairs the running seat by taking the slot
   * from whoever holds it, and it mints a member and trips the already-bound guard on the way.
   *
   * `'identity'` ⇒ the dead binding (install-topology §6(a)): this folder's credential is wrong for
   * the seat it claims. It outranks the other two, and `--fix` deliberately **cannot** perform it —
   * the remedy is either a rebind from a held credential or a re-issue that invalidates somebody's
   * live secret, and `musterd init` (the generic remedy) is the very command that wrote the binding.
   */
  repair?: 'wire' | 'init' | 'identity';
  /** Warn-only notes (locally-edited guidance) — surfaced but never exit-1 (ADR 085). */
  notes: string[];
  /** True when at least one installed harness has the musterd server registered. */
  anyConfigured: boolean;
}

/**
 * Guidance-file drift (ADR 085, re-anchored by ADR 171).
 *
 * The set inspected is what **this build would write** into this folder — `guidanceTargets` over the
 * harnesses established here — not the set the manifest recorded at provisioning time. That
 * distinction is the whole of ADR 171: a receipt can confirm a change or a deletion, but it is
 * structurally incapable of noticing an *addition*, so every guidance file added after a folder was
 * provisioned was invisible to this check. Measured before the change: the ADR 167 nudge-relay skill
 * was absent from 8 of 8 dogfood worktrees and drew zero drift lines.
 *
 * The manifest is still read, for two narrower jobs: its presence says this folder was provisioned
 * at all (an unprovisioned folder claims nothing, so there is nothing to check), and its file list
 * distinguishes a file that has *gone missing* from one that never arrived. It remains the exact
 * removal set for uninstall (ADR 030) — it just stops being the health check's source of truth.
 *
 * Expectation is scoped by `establishedHarnesses` — the same predicate `--refresh-guidance` uses to
 * decide what it will rewrite. Sharing it is load-bearing: the doctor must expect exactly what the
 * repair it prescribes would write, or it emits drift no command can clear.
 */
function inspectGuidance(cwd: string, harnesses: Harness[]): { drift: string[]; notes: string[] } {
  const drift: string[] = [];
  const notes: string[] = [];
  const recorded = readProvisionManifest(cwd)?.guidance;
  if (!recorded) return { drift, notes }; // pre-085 / never written — nothing claimed, nothing to check
  const wasRecorded = new Set(recorded.files);
  // Stale files are counted, not listed: one version bump used to emit one line PER FILE — six
  // identical-in-substance lines for a single fact on a real seat. ADR 168 pre-registered "becomes
  // noise" as a failure mode of its own instrument; ADR 171 §2 pays that debt. The remedy is
  // identical for every file, so the file list is not actionable and the count is.
  const staleByVersion = new Map<number, number>();
  for (const rel of guidanceTargets(establishedHarnesses(cwd, harnesses))) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) {
      drift.push(
        wasRecorded.has(rel)
          ? `the musterd skill file ${rel} is gone — run \`musterd init --refresh-guidance\` to restore it.`
          : `the musterd guidance file ${rel} is missing — it was added to musterd after this folder ` +
              `was provisioned, so nothing here has ever written it (ADR 171). Run ` +
              `\`musterd init --refresh-guidance\` to install it.`,
      );
      continue;
    }
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable — don't turn a transient read error into false drift
    }
    const stamp = parseContentStamp(text);
    if (!stamp) {
      // Never drift: a stampless file is the user's, whether they edited ours into anonymity or
      // authored their own at a path we would otherwise write. `writeOne` already refuses to clobber
      // it, so the honest report is a note about what musterd is declining to do.
      notes.push(
        wasRecorded.has(rel)
          ? `${rel} no longer carries a musterd stamp — treating it as yours (will not overwrite).`
          : `${rel} is a file of your own at a path musterd would otherwise write — leaving it alone.`,
      );
      continue;
    }
    if (stamp.version < GUIDANCE_CONTENT_VERSION) {
      staleByVersion.set(stamp.version, (staleByVersion.get(stamp.version) ?? 0) + 1);
    } else if (contentHash(strippedBody(text)) !== stamp.hash) {
      notes.push(
        `${rel} has local edits — this is a musterd-managed file, so \`musterd init\` will replace them ` +
          `on the next run. Put your own guidance in AGENTS.md (around the markers) to keep it.`,
      );
    }
  }
  // A recorded path that is no longer expected is a file musterd RETIRED. Deliberately silent: not
  // every absence is drift, and a doctor that nags about a path musterd itself stopped writing
  // teaches people to stop reading it.
  for (const [version, count] of [...staleByVersion].sort((a, b) => a[0] - b[0])) {
    drift.push(
      `${count === 1 ? '1 musterd guidance file is' : `${String(count)} musterd guidance files are`} ` +
        `v${String(version)}, current is v${String(GUIDANCE_CONTENT_VERSION)} — ` +
        // ADR 161: point at the refresh that touches ONLY guidance files. Plain `init` also mints
        // members and rewrites bindings, which is the wrong blast radius for a version bump —
        // and in a live seat's worktree, actively dangerous.
        `run \`musterd init --refresh-guidance\` to refresh them.`,
    );
  }
  return { drift, notes };
}

/**
 * Duplicate-adapter drift (ADR 092 §C): a host reload can orphan the previous MCP adapter, leaving two
 * processes bound to this folder's seat fighting over it. ADR 092's durability-gated reap self-heals
 * this, but the warn is cheap belt-and-suspenders — and it catches a stuck orphan before A/B would.
 * Best-effort + read-only: asks the server for this seat's live presences and warns (a **note**, never
 * exit-1 drift — the reap resolves it) when more than one shares this workspace. Silent if the folder
 * has no seat binding or the server is unreachable.
 */
async function inspectDuplicateAdapters(binding: Binding | null): Promise<string[]> {
  if (!binding?.server || !binding.team) return [];
  const seat = bindingSeat(binding);
  if (!seat) return []; // role/chat folder — no fixed seat to check
  let members;
  try {
    ({ members } = await new HttpClient({ server: binding.server }).roster(binding.team));
  } catch {
    return []; // server down / unreachable — a health check never invents drift
  }
  const workspace = resolveWorkspace();
  const live = (members.find((m) => m.name === seat)?.presences ?? []).filter(
    (p) => p.status !== 'offline' && p.workspace === workspace,
  );
  if (live.length <= 1) return [];
  return [
    `seat "${seat}" has ${live.length} live adapters in this workspace (${workspace}) — a host reload ` +
      `likely orphaned an earlier MCP process. This should self-resolve (ADR 092); if it persists, find ` +
      `the extra process (\`ps aux | grep packages/mcp/dist/index.js\`) and end it.`,
  ];
}

/**
 * Model-attestation drift (ADR 101): an adapter that stops attesting degrades to `unknown`
 * *silently* — every act it sends stops carrying a model and diversity conclusions on its chains
 * become unverifiable. Warn-only (a **note**, never exit-1): `unknown` is legal by design
 * (warn-never-block), but it should be a choice, not rot. Best-effort + read-only like the
 * duplicate-adapter check: silent when the folder has no seat or the server is unreachable.
 */
async function inspectModelAttestation(binding: Binding | null): Promise<string[]> {
  if (!binding?.server || !binding.team) return [];
  const seat = bindingSeat(binding);
  if (!seat) return [];
  let members;
  try {
    ({ members } = await new HttpClient({ server: binding.server }).roster(binding.team));
  } catch {
    return []; // server down / unreachable — a health check never invents drift
  }
  const workspace = resolveWorkspace();
  // This folder's live session(s). A stateless HTTP claim (SPEC A.7) attaches with a null workspace,
  // so a null-workspace live presence on this seat is also "here" — include it, or the note would
  // silently skip exactly the sessions most likely to under-attest.
  const liveHere = (members.find((m) => m.name === seat)?.presences ?? []).filter(
    (p) => p.status !== 'offline' && (p.workspace === workspace || p.workspace == null),
  );
  // Warn only when the seat is live here yet **no** session attests — one attested session means the
  // seat's acts carry a model, so an idle/ambient sibling row without one isn't drift.
  if (liveHere.length === 0 || liveHere.some((p) => p.model)) return [];
  return [
    `seat "${seat}"'s live MCP model declaration is unknown — its acts read as model: unknown and ` +
      `diversity conclusions on its chains become unverifiable (ADR 120). Set MUSTERD_MODEL (or ` +
      `let the harness env carry ANTHROPIC_MODEL) and reconnect to attest.`,
  ];
}

/**
 * The **dead binding** (install-topology §6(a)): a folder whose binding claims a *human* seat while
 * carrying the *team agent key*. It occupies once and then 403s on every subsequent request — the
 * state `/Users/nick/agents` was in for two days, written by `init`'s "activate an existing member"
 * intent handing `config.agentKeys[team]` to any target.
 *
 * L1 (#457) closed the door that produces this, so no new one can be written. This is the other
 * half: the ones already on disk are invisible until something fails, and the failure is a 403 that
 * names neither the cause nor the repair.
 *
 * Two things it deliberately does not do:
 *
 * - **Never flags an observer.** Observer seats are `kind: 'human'` with `observer: 1` (ADR 063) and
 *   are claimed with the agent key *by design* — every `/live` watch-link is exactly that shape. The
 *   rule is about authority, not the kind column, which is the same carve-out L1 needed.
 * - **Never guesses when the roster is unreachable.** Seat kind is only knowable from the daemon, so
 *   an offline run returns an honest "could not verify" note rather than either silence (which reads
 *   as healthy) or a guess (ADR 173 — absent is not unknown).
 *
 * The repair is *not* `musterd init`: that is the command that wrote the binding, and its remedy for
 * a live seat is an interactive identity rewrite. It is a credential command, and which one depends
 * on whether this machine still holds a usable credential for the seat — so the note names the one
 * that applies rather than both.
 */
/**
 * Seat git attribution (ADR 109): does this worktree carry the identity that makes `git log` answer
 * "which seat wrote this" without a lookup?
 *
 * A **note, never drift.** Nothing stops working when it is missing — commits still land, CI still
 * passes. They are simply authored by the human, so `git log`, the ADR 109 `git.pr_merged` join and
 * every per-seat rollup credit the wrong actor. That silence is the whole problem: two live seats
 * reached dozens of merges with zero seat trailers before a manual audit noticed.
 *
 * The prescribed repair is the two surgical `git config` writes, deliberately **not** `musterd init`.
 * On a repo-root-shared MCP entry (ADR 143) that generic remedy repoints the slot every other live
 * seat is using — ryder's #514 lesson that a check must expect what its own repair would actually
 * write, and the same reason ADR 168 carved identity out of the refresh path.
 */
function inspectGitAttribution(binding: Binding | null, cwd: string): string[] {
  const seat = binding ? bindingSeat(binding) : undefined;
  if (!seat || !binding?.team) return []; // no seat to attribute (role pool, or unprovisioned)

  /*
   * AGENT seats only, discriminated by the credential prefix (ADR 121's existing distinction: an
   * `mscr_` human credential is not a harness). A human already has a real git identity, and a
   * synthetic `nick@<team>.musterd` would be strictly worse — it breaks GitHub attribution and the
   * email linkage a person's commits depend on. Without this gate the check fires in the human's own
   * primary checkout and prescribes exactly that, which is the fleet-wide misfire class ADR 165 and
   * ryder's #514 were both about: a guard whose prescribed repair is wrong for most of who sees it.
   */
  if (!binding.agent_key?.startsWith(TOKEN_PREFIXES.agent_key)) return [];

  /*
   * Compares the EFFECTIVE identity, not the worktree-scoped slot. Reading `--worktree` directly looks
   * like the precise thing to do and is a trap: with `extensions.worktreeConfig` disabled git treats
   * `--worktree` as `--local`, so the human's repo identity reads back as if the seat were configured.
   * The effective value is also the honest question — "will a commit here be attributed to this seat?"
   * — and it catches a *wrong* identity as well as a missing one, which is the other half of the drift
   * (seats still carrying a pre-team-slug `@musterd.local` email land under two names in any rollup).
   */
  // Gate on being inside a repo first: `git config user.email` answers from ~/.gitconfig anywhere on
  // the filesystem, so without this a plain folder would be told to fix an identity it cannot have.
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' });
  } catch {
    return [];
  }
  const expected = `${seat}@${binding.team}.musterd`;
  let actual: string;
  try {
    actual = execFileSync('git', ['config', 'user.email'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return []; // not a git repo, or no identity at all to compare — nothing actionable here
  }
  if (actual === expected) return [];
  const repair =
    `    git config --worktree user.name "${seat} (musterd seat)"\n` +
    `    git config --worktree user.email "${expected}"`;
  return [
    `commits from this folder are attributed to "${actual}", not to seat ${seat} — \`git log\` and the ` +
      `ADR 109 per-seat rollups will credit the wrong actor. Nothing breaks, which is why this goes ` +
      `unnoticed. Repair it in place; do NOT run \`musterd init\`, which repoints the MCP entry every ` +
      `seat on this machine shares (ADR 143):\n${repair}`,
  ];
}

async function inspectSeatIdentity(
  binding: Binding | null,
  cwd: string,
): Promise<{ drift: string[]; notes: string[] }> {
  const empty = { drift: [], notes: [] };
  if (!binding?.server || !binding.team || !binding.agent_key) return empty;
  const seat = bindingSeat(binding);
  if (!seat) return empty; // a role pool resolves its seat server-side; there is nothing to compare

  // The local half of the evidence, computable offline: is this folder authenticating with the
  // *shared team key* rather than a seat credential? Exact match against what this machine recorded
  // at `team create` is the certain form; the `mskey_` prefix (ADR 075) catches a machine that never
  // held the team key but was handed one.
  const config = loadConfig();
  const carriesTeamKey =
    binding.agent_key === config.agentKeys[binding.team] || binding.agent_key.startsWith('mskey_');
  if (!carriesTeamKey) return empty;

  let members;
  try {
    ({ members } = await new HttpClient({ server: binding.server }).roster(binding.team));
  } catch {
    // Say what cannot be seen, and what the abstention costs — the alternative is a check that reads
    // as "healthy" precisely when it ran on nothing.
    return {
      drift: [],
      notes: [
        `couldn't verify seat "${seat}"'s identity — ${binding.server} is unreachable, and whether a ` +
          `seat is human is only knowable from the roster. This folder authenticates with the team ` +
          `agent key, which is correct for an agent seat and dead for a human one; re-run this check ` +
          `with the daemon up to tell which.`,
      ],
    };
  }
  const member = members.find((m) => m.name === seat);
  // A name absent from the roster is either a removed seat (a different fault) or an **observer** —
  // ADR 063 hides observers from the roster entirely (`observer = 0` in listPresence), and an
  // observer claiming with the team key is the design, not drift. Both correctly fall out here, so
  // the carve-out L1 needed explicitly is free on this surface.
  if (!member || member.kind !== 'human') return empty;

  // Which repair applies is a local fact: does this machine still hold a real credential for the seat?
  const held = config.knownIdentities.find(
    (i) =>
      i.team === binding.team &&
      i.name === seat &&
      i.key &&
      i.key !== config.agentKeys[binding.team],
  );
  const repair = held
    ? `\`musterd join ${binding.team} --as ${seat}\` here — this machine already holds their ` +
      `credential, so this rebinds the folder with nothing to paste`
    : `\`musterd team credential ${seat}\` here — this machine holds no credential for them, so it ` +
      `must be re-issued (their previous one stops working), and running it in this folder repairs ` +
      `this binding in the same breath`;
  return {
    drift: [
      `${cwd}/.musterd/binding.json claims seat "${seat}", the roster says "${seat}" is a human, and ` +
        `the binding carries the team agent key — the shared key may not act as a human seat, so this ` +
        `folder occupies once and then 403s on every request. Run ${repair}.`,
    ],
    notes: [],
  };
}

/**
 * The harness `musterd wire` would configure in THIS folder, for the repair sentence the doctor gives
 * a harness wire cannot reach. Derived from the same function wire itself dispatches on, so it cannot
 * go stale independently of the command it describes — and resolved per folder rather than per
 * machine, because which harness wire reaches is now a property of what the folder declares.
 */
function harnessLabelWireConfigures(surface: string | undefined): string {
  return harnessWiredFor(surface).label;
}

export async function inspectProvisioning(cwd: string): Promise<DoctorReport> {
  const primerManaged = classifyPrimerTarget(cwd) === 'managed';
  // The folder's single source of truth for which seat it claims (ADR 018). A legacy MCP registration
  // may still carry a baked `MUSTERD_CLAIM` that outranks it — the value-coherence check below.
  const binding = findBinding(cwd);
  const boundClaim = binding?.claim ? formatClaimPolicy(binding.claim) : undefined;
  // Which harness `wire` would reach here follows the folder's DECLARED surface — the committed spec
  // first (what wire itself reads), then the gitignored binding for a folder wired before the spec
  // existed. Undefined degrades to the default, exactly as wire does.
  const declaredSurface = findWorkspaceSpec(cwd)?.surface ?? binding?.surface;
  const drift: string[] = [];
  // Entry drift: the shared harness entry disagrees with this folder's binding.json. Tracked
  // separately from `drift` so `--fix` can route it to `musterd wire` (headless, whole-family)
  // instead of `musterd init` (mints a member, trips the bound guard, steals the shared slot).
  const entryDrift: string[] = [];

  const harnesses: HarnessState[] = [];
  let claudeConfigured = false;
  // Does any drifting entry belong to a harness `wire` can actually rewrite? Drives the `repair`
  // classification below: `--fix` must not run `wire` for drift it is structurally unable to touch.
  let anyWireRepairable = false;
  for (const h of HARNESSES) {
    const d = await h.detect();
    // The repair sentence, derived from what `wire` configures rather than assumed. Every drift
    // message below ends with `repairWith`, so a harness wire cannot reach never gets told to run it
    // — and since wire now follows the folder's declared surface, the harness a provisioned folder
    // actually uses is reachable, whichever one it is.
    // Two ways a repair can fail to reach the drift, and both must silence the prescription. The
    // harness may not be the one this folder declares — or it may be, while the entry that drifted
    // lives in a machine-global config `configure` never writes (`registeredElsewhere`). The second
    // is the quieter failure: everything looks repairable, `wire` runs, rewrites the project file,
    // and reports success with the drift untouched.
    const wireRepairs =
      wireConfigures(h.id, declaredSurface) && d.registeredElsewhere === undefined;
    const repairWith = wireRepairs
      ? 'Run `musterd wire` here to rewrite the entry without it'
      : d.registeredElsewhere !== undefined
        ? `this entry lives in ${d.registeredElsewhere}, which musterd does not write — it writes ` +
          `the project file, so no command run in this folder rewrites it. Edit that file directly, ` +
          `and check what else depends on it first: a machine-global entry is how other seats on ` +
          `this machine may be launching`
        : `\`musterd wire\` does not rewrite ${h.label}'s entry here — this folder is provisioned for ` +
          `${harnessLabelWireConfigures(declaredSurface)}, so that is the entry it rewrites. ` +
          `Re-provision this folder with \`musterd init\` and pick ${h.label}, or drop the line from ` +
          `${h.label}'s own entry file by hand`;
    // Record entry drift AND whether `wire` could repair this particular one, so the `repair`
    // classification below never routes `--fix` at a command that cannot touch the drift it found.
    const noteEntryDrift = (text: string) => {
      entryDrift.push(text);
      if (wireRepairs) anyWireRepairable = true;
    };
    if (h.id === 'claude-code' && d.configured) claudeConfigured = true;
    harnesses.push({
      label: h.label,
      installed: d.installed,
      configured: d.configured,
      ...(d.detail !== undefined ? { detail: d.detail } : {}),
    });
    // Value-coherence: a legacy baked MUSTERD_CLAIM that disagrees with binding.json pins this
    // harness's team_* tools to a stale seat while the CLI claims the current one (the re-claim drift).
    if (
      d.registeredClaim !== undefined &&
      boundClaim !== undefined &&
      d.registeredClaim !== boundClaim
    ) {
      noteEntryDrift(
        `${h.label}'s musterd server has a baked MUSTERD_CLAIM=${d.registeredClaim} but ` +
          `.musterd/binding.json claims ${boundClaim} — the team_* tools will resolve a different ` +
          `seat than the musterd CLI in this folder. ${repairWith} (provisioning no longer bakes the ` +
          `claim, so binding.json becomes the single source of truth).`,
      );
    }
    // A legacy baked MUSTERD_MODEL. Provisioning stopped emitting it, but entries written before that
    // still carry one at the TOP of the adapter's ladder, where no observation can correct it — the
    // exact shape that had a seat attesting `grok-4.5` for weeks while running `claude-opus-4-8`.
    // MUSTERD_SURFACE, the one this set was missing. Same legacy-snapshot argument as the model above,
    // and measured biting on 2026-08-03: a pre-ADR-165 `.cursor/mcp.json` still baked
    // `MUSTERD_SURFACE=cursor`, which outranks binding.json and — unlike model — has no observation
    // path that could ever correct it, so the seat reported `cursor` while a claude-code hook was
    // demonstrably capturing its sessions (PR #607 made the contradiction visible; this names the
    // entry that causes it).
    if (d.registeredSurface !== undefined) {
      noteEntryDrift(
        `${h.label}'s musterd server bakes MUSTERD_SURFACE=${d.registeredSurface} — a wire-time ` +
          `snapshot that outranks .musterd/binding.json and that no observation can correct, so the ` +
          `roster, presence and audit report whatever it says. ${repairWith}.`,
      );
    }
    if (d.registeredModel !== undefined) {
      noteEntryDrift(
        `${h.label}'s musterd server bakes MUSTERD_MODEL=${d.registeredModel} — a wire-time snapshot ` +
          `that outranks what the harness is actually running, and that no later observation can ` +
          `correct. ${repairWith}.`,
      );
    }
    // Per-seat SECRETS in a registered entry (ADR 143/165). Flagged on PRESENCE, not on mismatch —
    // but the REASON depends on how far the entry reaches, so the note must not assert one harness's
    // story about another's file. A repo-shared entry (Claude Code, keyed by repo root) is a
    // family-bleed: a grant that matches *this* folder is still every sibling worktree's credential.
    // A per-folder entry (`.cursor/mcp.json`, `.codex/config.toml`) has no sibling to bleed onto, and
    // musterd's own init gitignores it — so "committable" would be a claim this cannot make (checked:
    // `.gitignore` already lists `.cursor/mcp.json`). What survives is precedence: a baked credential
    // sits ABOVE binding.json in the adapter's ladder, so once it goes stale, re-minting the seat
    // (`musterd agent <seat>`) writes a fresh key the adapter never reads, and the seat keeps failing
    // to claim with a repair that looks like it should have worked.
    // A third reach, wider than either: the entry read was the harness's MACHINE-GLOBAL config, so
    // the credential is not one worktree's or one repo's — it is every folder's on this machine, and
    // it is what a harness launched anywhere here will authenticate as. Understating that as "in the
    // entry itself" (the per-folder wording) is the difference between a stale-key nuisance and one
    // seat's credential silently backing every Codex session on the box. Measured 2026-08-05.
    const machineGlobal = d.registeredElsewhere !== undefined;
    const shared = h.entryScope === 'repo-shared' && !machineGlobal;
    for (const [name, value, why] of [
      [
        'MUSTERD_GRANT',
        d.registeredGrant,
        machineGlobal
          ? 'so any seat launched anywhere on this machine presents this grant at claim time'
          : shared
            ? 'so a sibling seat presents this grant at claim time and gets denied or sent to approval'
            : 'and it outranks binding.json, so re-minting the seat cannot repair a stale one',
      ],
      [
        'MUSTERD_AGENT_KEY',
        d.registeredAgentKey,
        machineGlobal
          ? 'so any seat launched anywhere on this machine may authenticate with this team key rather than its own'
          : shared
            ? 'so a sibling seat may authenticate with this team key rather than its own'
            : 'and it outranks binding.json, so re-minting the seat cannot repair a stale one',
      ],
    ] as const) {
      if (value === undefined) continue;
      // The repair clause used to be hard-coded here as an unconditional "Run `musterd wire` here:
      // it rewrites the entry from .musterd/binding.json without secrets" — and the `shared`
      // ternary gave that MOST confident wording to the per-folder branch, i.e. exactly the
      // harnesses wire never touches. Derive it instead.
      noteEntryDrift(
        `${h.label}'s musterd server bakes ${name} — a per-seat secret in ` +
          (machineGlobal
            ? `${h.label}'s MACHINE-GLOBAL config, which every folder on this machine reads, `
            : shared
              ? `an entry ${h.label} keys by repo ROOT, which every git worktree of this repo shares, `
              : `the entry itself, `) +
          `${why}. ` +
          (wireRepairs
            ? `Run \`musterd wire\` here: it rewrites the entry from .musterd/binding.json ` +
              `without secrets` +
              (shared
                ? `, and because the entry is shared, one run repairs every seat in the family.`
                : `.`)
            : `${repairWith}.`),
      );
    }
    // Per-worktree POLICY in the shared slot (ADR 165 inc 2) — not secrets, but the same family-bleed
    // shape: a baked autojoin forces join-on-launch for every sibling worktree, and a baked driver
    // marks the whole family as driven by one human (corrupting ADR 155 driver co-presence).
    // Provisioning now writes both to .musterd/binding.json instead; flagged on presence.
    if (d.registeredAutojoin !== undefined) {
      noteEntryDrift(
        `${h.label}'s musterd server bakes MUSTERD_AUTOJOIN=${d.registeredAutojoin} — join-on-launch ` +
          (shared
            ? `policy in an entry every worktree of this repo shares, so it applies family-wide instead of per seat. `
            : `policy pinned in the entry, where it outranks the per-workspace setting. `) +
          `Provisioning now records it in .musterd/binding.json; ${repairWith}.`,
      );
    }
    if (d.registeredDriver !== undefined) {
      noteEntryDrift(
        `${h.label}'s musterd server bakes MUSTERD_DRIVER=${d.registeredDriver} — ` +
          (shared
            ? `a driver in the repo-root-shared entry marks EVERY sibling worktree as driven by ${d.registeredDriver}, `
            : `a driver pinned in the entry outranks the per-workspace setting, `) +
          `corrupting driver co-presence (ADR 155). Provisioning now records the driver in ` +
          `.musterd/binding.json; ${repairWith}.`,
      );
    }
    // An adapter inside a sibling seat's workspace: a note, not a refusal — identity comes from cwd,
    // so what this costs is running another checkout's build and breaking if that folder moves.
    // The repo's PRIMARY checkout is excluded: one entry is shared by every worktree (ADR 143), so an
    // adapter there is the shared install rather than drift, and prescribing a repair for it handed
    // 11 of 12 dogfood seats a line whose fix just moved the failure to the other 11.
    if (d.registeredArgs !== undefined) {
      const note = foreignAdapterNote(
        { args: d.registeredArgs },
        {
          workspaceDir: cwd,
          siblingDirs: siblingWorkspaces(cwd),
          primaryCheckout: primaryCheckoutFor(cwd),
        },
      );
      if (note !== undefined) drift.push(note);
    }
  }
  // The attestation tripwire. The original (#273) fired only on an *absent* declaration, so a
  // confidently WRONG one was indistinguishable from a correct one — the mode that poisons ADR 056
  // diversity conclusions while looking perfectly healthy, and the reason a seat could attest
  // `grok-4.5` for weeks while running `claude-opus-4-8`. Compare the two tiers and name the knob
  // that lies, plus where it lives, so the fix is obvious instead of a hunt down the ladder.
  const observedModel = binding?.model_observed;
  if (observedModel && binding?.model && binding.model !== observedModel.model) {
    drift.push(
      `this workspace declares model "${binding.model}" but its ${observedModel.harness} session was ` +
        `observed running "${observedModel.model}" — the observation is what gets attested; remove or ` +
        `correct the stale declaration in .musterd/binding.json (and check for a baked MUSTERD_MODEL ` +
        `in the harness MCP entry, which provisioning no longer writes).`,
    );
  }
  // The same tripwire, one field over. `surface` never got the observation path `model` did (ADR 158),
  // so it is believed on the strength of a declaration alone — while labelling every presence row,
  // audit entry and roster line as fact. A capture is the evidence the declaration lacks: hooks are
  // harness-specific by construction, so a `claude-code` capture is proof Claude Code ran here.
  // Measured across eleven seat worktrees 2026-08-03 — one disagreed, declaring `cursor` while both
  // its session and its model observation were written by `claude-code`.
  const ranHarness = binding?.session?.harness ?? binding?.model_observed?.harness;
  if (ranHarness && binding?.surface && binding.surface !== ranHarness) {
    drift.push(
      `this workspace declares surface "${binding.surface}" but its session here was captured by ` +
        `"${ranHarness}" — a ${ranHarness} hook only fires under ${ranHarness}, so the declaration is ` +
        `the stale one, and it is what the roster, presence and audit report this seat is running. ` +
        `Correct it in .musterd/binding.json (and check for a baked MUSTERD_SURFACE in the harness ` +
        `MCP entry, which outranks the binding and which no observation can reach).`,
    );
  }

  const installed = harnesses.filter((h) => h.installed);
  const anyConfigured = installed.some((h) => h.configured);

  // The headline gap: marker present (hook will claim "auto-joined") but no server registered.
  if (primerManaged && installed.length > 0 && !anyConfigured) {
    drift.push(
      'AGENTS.md has the musterd primer but no harness has the musterd MCP server registered for ' +
        'this folder — the SessionStart hook will tell an agent it is auto-joined while the team_* ' +
        'tools are unavailable. Run `musterd init` here to register the server.',
    );
  }
  // The reverse: server wired, but agents land with no primer to orient them.
  if (anyConfigured && !primerManaged) {
    drift.push(
      'The musterd MCP server is registered but AGENTS.md has no musterd primer — agents will have ' +
        'the team_* tools but no orientation and the SessionStart hook stays silent. Run `musterd init` ' +
        'to add the primer.',
    );
  }
  // ADR 088: the interrupt hook is reachability-critical and lives in machine-local settings (never
  // committed), so a provisioned folder can silently lose it. Check it only when Claude Code has the
  // server wired here — the only harness with a PostToolUse hook today.
  if (claudeConfigured) drift.push(...inspectClaudeHookDrift(cwd));
  const guidance = inspectGuidance(cwd, HARNESSES);
  drift.push(...guidance.drift);
  const duplicateAdapters = await inspectDuplicateAdapters(binding);
  const modelAttestation = await inspectModelAttestation(binding);
  const seatIdentity = await inspectSeatIdentity(binding, cwd);
  // ADR 160/185: label coverage is per-capability (cross_rename / self_rename / none). Say so
  // plainly (a note, never drift — capability gaps are not misconfiguration).
  const noPeerSweep = HARNESSES.filter(
    (h) => !h.guidance?.sessionsSkillPath && harnesses.find((s) => s.label === h.label)?.configured,
  );
  const selfLabel = noPeerSweep.filter((h) => h.guidance?.selfLabelSkillPath);
  const terminalOnly = noPeerSweep.filter((h) => !h.guidance?.selfLabelSkillPath);
  // ADR 162: the binding registry only grows — nothing prunes an entry when its folder is deleted.
  // Warn-only and cheap (one stat per entry), and only worth saying once it is actually noisy.
  const staleBindings = Object.keys(loadConfig().bindings).filter((f) => !existsSync(f));
  const registryNotes =
    staleBindings.length >= 5
      ? [
          `${staleBindings.length} binding-registry entries name folders that no longer exist — ` +
            `run \`musterd init --prune-bindings\` to review, \`--apply\` to remove. Credentials are untouched.`,
        ]
      : [];
  const labelNotes = [
    ...(selfLabel.length > 0
      ? [
          `${selfLabel.map((h) => h.label).join(' + ')}: seat labels = terminal OSC + current-chat ` +
            `self-rename when the harness rename tool is present (ADR 186 self_rename) — no peer sidebar sweep.`,
        ]
      : []),
    ...(terminalOnly.length > 0
      ? [
          `${terminalOnly.map((h) => h.label).join(' + ')}: seat labels reach the terminal tab only — ` +
            `no session rename API for a sidebar write (ADR 160/185).`,
        ]
      : []),
  ];
  // Classify BEFORE merging so the distinction survives into `--fix`. Identity drift wins outright:
  // the seat is dead, no other repair reaches it, and the generic remedy would make it worse. Then
  // entry drift (repairable headlessly by `wire`), then everything else (full onboarding).
  // `wire` is only the answer for entry drift it can actually reach. Per-folder drift (Cursor,
  // Codex) is real drift, but wire configures Claude Code alone — classifying it 'wire' made
  // `--fix` run a command that changed nothing and then report it as the remedy. Fall through to
  // 'init', which does re-provision the chosen harness's entry.
  const repair: DoctorReport['repair'] =
    seatIdentity.drift.length > 0
      ? 'identity'
      : drift.length > 0
        ? 'init'
        : entryDrift.length > 0
          ? anyWireRepairable
            ? 'wire'
            : 'init'
          : undefined;
  drift.push(...seatIdentity.drift, ...entryDrift);
  return {
    primerManaged,
    harnesses,
    drift,
    ...(repair !== undefined ? { repair } : {}),
    notes: [
      ...guidance.notes,
      ...duplicateAdapters,
      ...modelAttestation,
      ...seatIdentity.notes,
      ...inspectGitAttribution(binding, cwd),
      ...registryNotes,
      ...labelNotes,
      ...packagedInstallNotes(),
    ],
    anyConfigured,
  };
}

/**
 * Footprint note (ADR 242, seat-footprint design): orphaned MCP sidecars the daemon's sampler can
 * see. Warn-only and best-effort like the skew notes — an unreachable daemon, a pre-241 daemon
 * (404), or an unbound folder all stay silent; the doctor reports drift, it never invents it.
 */
export async function footprintNotes(
  cwd: string = process.cwd(),
  deps?: {
    fetchTick?: () => Promise<
      { stacks: { classification: string; procs: number; rss_kb: number }[] } | undefined
    >;
  },
): Promise<string[]> {
  const fetchTick =
    deps?.fetchTick ??
    (async () => {
      const binding = findBinding(cwd);
      if (!binding?.team || !binding.agent_key) return undefined;
      const res = await fetch(
        `${binding.server}/teams/${encodeURIComponent(binding.team)}/footprint`,
        {
          headers: {
            authorization: `Bearer ${binding.agent_key}`,
            ...(binding.claim?.mode === 'seat' ? { 'x-musterd-seat': binding.claim.name } : {}),
          },
          signal: AbortSignal.timeout(2000),
        },
      );
      if (!res.ok) return undefined;
      return (await res.json()) as {
        stacks: { classification: string; procs: number; rss_kb: number }[];
      };
    });
  const tick = await fetchTick().catch(() => undefined);
  if (!tick) return [];
  const orphaned = tick.stacks.filter((s) => s.classification === 'orphaned');
  const procs = orphaned.reduce((sum, s) => sum + s.procs, 0);
  if (procs === 0) return [];
  const mb = Math.round(orphaned.reduce((sum, s) => sum + s.rss_kb, 0) / 1024);
  return [
    `${procs} orphaned MCP sidecar proc${procs === 1 ? '' : 's'} (~${mb} MB RSS) from ended sessions — \`musterd reap\` reclaims them.`,
  ];
}

/** Render + exit-code for `musterd init --check`. Exit 1 on drift, 0 when healthy or unprovisioned. */
/**
 * Build-skew notes (ADR 135): is the `musterd` you just typed the code you think it is? Two
 * comparisons, both best-effort and warn-only (freshness is a fact, not provisioning drift):
 *   (a) this CLI's dist stamp vs the daemon's `/health.build` — offline SHA equality, and
 *   (b) this CLI's dist stamp vs `origin/main` — behind/ahead counts, git-gated.
 * Silence when a side is unknown (unstamped dist, unreachable daemon, no checkout) — never guess.
 */
export async function buildSkewNotes(deps?: {
  cliRef?: string | undefined;
  daemonBuild?: () => Promise<string | undefined>;
  repoDir?: string;
}): Promise<string[]> {
  const notes: string[] = [];
  const ref = deps?.cliRef !== undefined ? deps.cliRef : cliBuild();
  if (!ref) return notes;
  const short = ref.slice(0, 7);

  // (a) vs the daemon — the fleet reference (level-2 skew, ADR 135): "differs", never "behind".
  const fetchDaemon =
    deps?.daemonBuild ??
    (async () => {
      const server = loadConfig().server;
      const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(2000) });
      return ((await res.json()) as { build?: string }).build;
    });
  const daemon = await fetchDaemon().catch(() => undefined);
  if (daemon && !sameCommit(daemon, ref)) {
    notes.push(
      `your CLI build (${short}) differs from the daemon (${daemon.slice(0, 7)}) — rebuild your checkout (pnpm build).`,
    );
  }

  // (b) vs origin/main — behind/ahead, only where a checkout + git exist. Strip -dirty for plumbing.
  const dir = deps?.repoDir ?? resolvePath(process.argv[1] ?? '', '../../../..');
  const sha = ref.replace(/-dirty$/, '');
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
    } catch {
      return null;
    }
  };
  if (git('rev-parse', '--is-inside-work-tree') === 'true') {
    git('fetch', 'origin', 'main', '--quiet'); // best-effort — offline compares the last-known tip
    const behind = Number(git('rev-list', '--count', `${sha}..origin/main`));
    if (Number.isFinite(behind) && behind > 0) {
      notes.push(
        `your CLI build (${short}) is ${behind} commit${behind === 1 ? '' : 's'} behind origin/main — sync + rebuild your checkout.`,
      );
    }
  }
  return notes;
}

/**
 * Do two build refs name the same commit, ignoring the `-dirty` uncommitted-work marker?
 *
 * A seat with uncommitted edits builds `<sha>-dirty` while the daemon runs a clean `<sha>`. That is
 * not skew — it is the normal state of a worktree someone is working in, and the dist *is* the code
 * they think it is. Reporting it was doubly wrong: both refs render identically once truncated for
 * display, so the line literally read "your CLI build (3260685) differs from the daemon (3260685)",
 * and its advice ("rebuild it") could not help, because the difference was the developer's own edits.
 * A skew line that fires constantly on every active seat is the noise failure ADR 168 named.
 *
 * Genuine skew still reports: a different commit differs with or without the marker.
 */
function sameCommit(a: string, b: string): boolean {
  return a.replace(/-dirty$/, '') === b.replace(/-dirty$/, '');
}

/**
 * Provisioning artifacts in this folder that disagree with what this build would write (ADR 171).
 *
 * The cheap half of the doctor, and cheap is the whole design constraint — this runs at every session
 * start. It is pure file I/O: no network, no git, and critically **no `detect()`**, which shells out
 * to `claude mcp get` and costs seconds. `inspectGuidance` needs only `existsSync` + stamp reads, and
 * `inspectClaudeHookDrift` only reads `.claude/settings.local.json`, so both qualify while
 * `inspectProvisioning` as a whole does not.
 */
export function inspectArtifactDrift(cwd: string): { guidance: string[]; hooks: string[] } {
  return {
    guidance: inspectGuidance(cwd, HARNESSES).drift,
    // Returns [] when there is no local settings file, so an unprovisioned folder stays silent.
    hooks: inspectClaudeHookDrift(cwd),
  };
}

/**
 * `musterd init --check-build`: the SessionStart probe (ADR 135 build skew + ADR 171 artifact drift).
 *
 * **Why the flag is still called `--check-build`.** It now reports more than the build, but every
 * hook installed across the fleet invokes it by that name, and renaming it would strand each seat
 * until it re-provisioned — the exact rot ADR 171 exists to close. Keeping the flag is also what lets
 * this capability arrive with **no hook-text change and no `FEATURE_EPOCH` bump**: behaviour that
 * lives in the CLI reaches every seat whose hook is already installed, while behaviour placed in the
 * hook *string* reaches only seats that re-run provisioning. Prefer the CLI side of that line.
 *
 * The contract is unchanged and load-bearing: silent when clean, **always exit 0**, never throws, and
 * bounded output — this stdout lands in model context every session, so drift is reported as ONE line
 * naming counts and only the repairs actually needed, never one line per file however many drifted.
 */
export async function runSessionProbe(deps?: {
  cliRef?: string | undefined;
  daemonBuild?: () => Promise<string | undefined>;
  cwd?: string;
}): Promise<number> {
  const ref = deps?.cliRef !== undefined ? deps.cliRef : cliBuild();
  if (ref) {
    try {
      const fetchDaemon =
        deps?.daemonBuild ??
        (async () => {
          const server = loadConfig().server;
          const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(2000) });
          return ((await res.json()) as { build?: string }).build;
        });
      const daemon = await fetchDaemon();
      if (daemon && !sameCommit(daemon, ref)) {
        process.stdout.write(
          `musterd: your CLI build (${ref.slice(0, 7)}) differs from the daemon (${daemon.slice(0, 7)}) — this checkout's dist is stale. Rebuild it (pnpm build); if your MCP tools also warn, /mcp reload after.\n`,
        );
      }
    } catch {
      // daemon down / unreachable — silence, never noise at session start
    }
  }
  try {
    const { guidance, hooks } = inspectArtifactDrift(deps?.cwd ?? process.cwd());
    if (guidance.length + hooks.length > 0) {
      const what = [
        guidance.length > 0 ? `${String(guidance.length)} guidance file(s)` : null,
        hooks.length > 0 ? `${String(hooks.length)} hook(s)` : null,
      ].filter(Boolean);
      const fix = [
        guidance.length > 0 ? '`musterd init --refresh-guidance`' : null,
        hooks.length > 0 ? '`musterd init --refresh-hooks`' : null,
      ].filter(Boolean);
      process.stdout.write(
        `musterd: this folder's provisioning is behind what this build writes — ${what.join(' and ')} ` +
          `missing or stale (ADR 171). Run ${fix.join(' and ')} to repair, ` +
          `or \`musterd init --check\` for the detail.\n`,
      );
    }
  } catch {
    // A health probe never fails a session start, and never invents drift from a folder it cannot read.
  }
  return 0;
}

export async function runInitDoctor(json: boolean, cwd: string = process.cwd()): Promise<number> {
  const report = await inspectProvisioning(cwd);
  // ADR 135: freshness notes ride the report (warn-only, never drift/exit-1).
  report.notes.push(...(await buildSkewNotes()));
  // ADR 242: orphaned-sidecar note — a machine fact like the skew notes, warn-only, never drift.
  report.notes.push(...(await footprintNotes(cwd)));
  // The binary a WAKE would resolve is a different question from the one this shell resolves, and
  // nothing asked it until a poisoned shim went a day unnoticed. Warn-only for the same reason as
  // the skew notes: it is a fact about the machine, not this folder's provisioning.
  const wake = inspectWakeMusterd();
  if (wake.problem) {
    report.notes.push(
      `a woken session's \`musterd\` is broken — ${wake.problem}. Its hooks (session attestation, ` +
        `autojoin, the interrupt line) would all fail silently, because \`command -v musterd\` still ` +
        `succeeds. The running host rewrites ${wake.shim} on its next wake; delete it to fall back to PATH.`,
    );
  }
  if (json) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return report.drift.length > 0 ? 1 : 0;
  }

  for (const h of report.harnesses) {
    if (!h.installed) {
      process.stdout.write(`${theme.meta('·')} ${h.label}: not installed\n`);
      continue;
    }
    const mark = h.configured ? theme.ok('✓') : theme.warn('•');
    const state = h.configured ? 'musterd server registered' : 'no musterd server';
    const detail = h.detail ? theme.meta(` (${h.detail})`) : '';
    process.stdout.write(`${mark} ${h.label}: ${state}${detail}\n`);
  }
  const primer = report.primerManaged
    ? `${theme.ok('✓')} AGENTS.md: musterd primer present\n`
    : `${theme.warn('•')} AGENTS.md: no musterd primer\n`;
  process.stdout.write(primer);

  for (const n of report.notes) process.stdout.write(`${theme.warn('•')} ${n}\n`);

  if (report.drift.length > 0) {
    process.stdout.write('\n');
    for (const d of report.drift) process.stdout.write(`${theme.err('✗')} ${d}\n`);
    return 1;
  }
  if (!report.primerManaged && !report.anyConfigured) {
    process.stdout.write(
      `\n${theme.meta('·')} this folder is not provisioned for musterd — run \`musterd init\` to set it up\n`,
    );
    return 0;
  }
  process.stdout.write(`\n${theme.ok('✓')} provisioning is coherent — primer and server agree\n`);
  return 0;
}
