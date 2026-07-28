import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { resolveWorkspace } from '@musterd/mcp';
import {
  GUIDANCE_CONTENT_VERSION,
  bindingSeat,
  formatClaimPolicy,
  parseContentStamp,
  type Binding,
} from '@musterd/protocol';
import { HttpClient } from '../client.js';
import { findBinding, loadConfig } from '../config.js';
import { theme } from '../render/theme.js';
import { packagedInstallNotes } from '../runtime.js';
import { cliBuild } from '../version.js';
import { foreignAdapterNote, siblingWorkspaces } from './entryGuard.js';
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
   */
  repair?: 'wire' | 'init';
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

export async function inspectProvisioning(cwd: string): Promise<DoctorReport> {
  const primerManaged = classifyPrimerTarget(cwd) === 'managed';
  // The folder's single source of truth for which seat it claims (ADR 018). A legacy MCP registration
  // may still carry a baked `MUSTERD_CLAIM` that outranks it — the value-coherence check below.
  const binding = findBinding(cwd);
  const boundClaim = binding?.claim ? formatClaimPolicy(binding.claim) : undefined;
  const drift: string[] = [];
  // Entry drift: the shared harness entry disagrees with this folder's binding.json. Tracked
  // separately from `drift` so `--fix` can route it to `musterd wire` (headless, whole-family)
  // instead of `musterd init` (mints a member, trips the bound guard, steals the shared slot).
  const entryDrift: string[] = [];

  const harnesses: HarnessState[] = [];
  let claudeConfigured = false;
  for (const h of HARNESSES) {
    const d = await h.detect();
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
      entryDrift.push(
        `${h.label}'s musterd server has a baked MUSTERD_CLAIM=${d.registeredClaim} but ` +
          `.musterd/binding.json claims ${boundClaim} — the team_* tools will resolve a different ` +
          `seat than the musterd CLI in this folder. Run \`musterd wire\` to re-sync (it no longer ` +
          `bakes the claim, so binding.json becomes the single source of truth).`,
      );
    }
    // A legacy baked MUSTERD_MODEL. Provisioning stopped emitting it, but entries written before that
    // still carry one at the TOP of the adapter's ladder, where no observation can correct it — the
    // exact shape that had a seat attesting `grok-4.5` for weeks while running `claude-opus-4-8`.
    if (d.registeredModel !== undefined) {
      entryDrift.push(
        `${h.label}'s musterd server bakes MUSTERD_MODEL=${d.registeredModel} — a wire-time snapshot ` +
          `that outranks what the harness is actually running, and that no later observation can ` +
          `correct. Run \`musterd wire\` here to rewrite the entry without it.`,
      );
    }
    // Per-seat SECRETS in a slot shared by every seat worktree of this repo (ADR 143/165). Flagged on
    // PRESENCE, not on mismatch: the entry is keyed by repo root, so a grant that matches *this*
    // folder is still the credential every sibling worktree reads — and it outranks their own
    // binding.json in the adapter's ladder. Provisioning no longer writes either one.
    for (const [name, value, why] of [
      [
        'MUSTERD_GRANT',
        d.registeredGrant,
        'so a sibling seat presents this grant at claim time and gets denied or sent to approval',
      ],
      [
        'MUSTERD_AGENT_KEY',
        d.registeredAgentKey,
        'so a sibling seat may authenticate with this team key rather than its own',
      ],
    ] as const) {
      if (value === undefined) continue;
      entryDrift.push(
        `${h.label}'s musterd server bakes ${name} — a per-seat secret in an entry Claude Code keys ` +
          `by repo ROOT, which every git worktree of this repo shares, ${why}. ` +
          `Run \`musterd wire\` here: it rewrites the entry from .musterd/binding.json without ` +
          `secrets, and because the entry is shared, one run repairs every seat in the family.`,
      );
    }
    // Per-worktree POLICY in the shared slot (ADR 165 inc 2) — not secrets, but the same family-bleed
    // shape: a baked autojoin forces join-on-launch for every sibling worktree, and a baked driver
    // marks the whole family as driven by one human (corrupting ADR 155 driver co-presence).
    // Provisioning now writes both to .musterd/binding.json instead; flagged on presence.
    if (d.registeredAutojoin !== undefined) {
      entryDrift.push(
        `${h.label}'s musterd server bakes MUSTERD_AUTOJOIN=${d.registeredAutojoin} — join-on-launch ` +
          `policy in an entry every worktree of this repo shares, so it applies family-wide instead of ` +
          `per seat. Provisioning now records it in .musterd/binding.json; run \`musterd wire\` here to ` +
          `rewrite the entry without it (one run repairs the family).`,
      );
    }
    if (d.registeredDriver !== undefined) {
      entryDrift.push(
        `${h.label}'s musterd server bakes MUSTERD_DRIVER=${d.registeredDriver} — a driver in the ` +
          `repo-root-shared entry marks EVERY sibling worktree as driven by ${d.registeredDriver}, ` +
          `corrupting driver co-presence (ADR 155). Provisioning now records the driver in ` +
          `.musterd/binding.json; run \`musterd wire\` here to rewrite the entry without it.`,
      );
    }
    // An adapter inside a sibling seat's workspace: a note, not a refusal — identity comes from cwd,
    // so what this costs is running another checkout's build and breaking if that folder moves.
    if (d.registeredArgs !== undefined) {
      const note = foreignAdapterNote(
        { args: d.registeredArgs },
        { workspaceDir: cwd, siblingDirs: siblingWorkspaces(cwd) },
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
  // ADR 160: label coverage is per-surface, and some harnesses have no writable session list at
  // all. Say so plainly (a note, never drift — there is nothing to fix) instead of pretending.
  const sidebarless = HARNESSES.filter(
    (h) => !h.guidance?.sessionsSkillPath && harnesses.find((s) => s.label === h.label)?.configured,
  );
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
  const labelNotes =
    sidebarless.length > 0
      ? [
          `${sidebarless.map((h) => h.label).join(' + ')}: seat labels reach the terminal tab only — ` +
            `no writable session list for a sidebar sweep (ADR 160).`,
        ]
      : [];
  // Entry drift is repairable headlessly; anything else needs full onboarding. Classify BEFORE
  // merging so the distinction survives into `--fix`.
  const repair: 'wire' | 'init' | undefined =
    drift.length > 0 ? 'init' : entryDrift.length > 0 ? 'wire' : undefined;
  drift.push(...entryDrift);
  return {
    primerManaged,
    harnesses,
    drift,
    ...(repair !== undefined ? { repair } : {}),
    notes: [
      ...guidance.notes,
      ...duplicateAdapters,
      ...modelAttestation,
      ...registryNotes,
      ...labelNotes,
      ...packagedInstallNotes(),
    ],
    anyConfigured,
  };
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
  if (daemon && daemon !== ref) {
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
 * `musterd init --check-build` (ADR 135): the hook-cheap freshness probe — ONLY the CLI-vs-daemon
 * SHA compare (one 2s health fetch, no git, no manifest reads). One line on stdout when the builds
 * differ, silence otherwise, and ALWAYS exit 0 — this runs inside the SessionStart hook, which must
 * never fail or slow a session start.
 */
export async function runCheckBuild(deps?: {
  cliRef?: string | undefined;
  daemonBuild?: () => Promise<string | undefined>;
}): Promise<number> {
  const ref = deps?.cliRef !== undefined ? deps.cliRef : cliBuild();
  if (!ref) return 0;
  try {
    const fetchDaemon =
      deps?.daemonBuild ??
      (async () => {
        const server = loadConfig().server;
        const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(2000) });
        return ((await res.json()) as { build?: string }).build;
      });
    const daemon = await fetchDaemon();
    if (daemon && daemon !== ref) {
      process.stdout.write(
        `musterd: your CLI build (${ref.slice(0, 7)}) differs from the daemon (${daemon.slice(0, 7)}) — this checkout's dist is stale. Rebuild it (pnpm build); if your MCP tools also warn, /mcp reload after.\n`,
      );
    }
  } catch {
    // daemon down / unreachable — silence, never noise at session start
  }
  return 0;
}

export async function runInitDoctor(json: boolean, cwd: string = process.cwd()): Promise<number> {
  const report = await inspectProvisioning(cwd);
  // ADR 135: freshness notes ride the report (warn-only, never drift/exit-1).
  report.notes.push(...(await buildSkewNotes()));
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
