import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  SEAT_CHIP,
  bindingSeat,
  capitalizeSeat,
  parseSeatLabel,
  renderSeatLabel,
  type SessionCapture,
} from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, findWorkspaceSpec, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import { HARNESSES } from '../onboard/harnesses/index.js';
import { clock, theme } from '../render/theme.js';
import { enumerateClaudeSessions } from '../session/enumerate.js';
import {
  LOCAL_SESSION_LIVE_MS,
  localSessionLiveness,
  type LocalSessionLiveness,
} from '../session/liveness.js';
import { findWorkspaceDir } from './helpers.js';

/**
 * `musterd session start|end --stdin | show` (ADR 131 §5, increment 4) — session capture. The
 * SessionStart/SessionEnd hooks pipe the harness's hook JSON (`{session_id, transcript_path, cwd}`)
 * into `start`/`end`, which write `binding.session` — the workspace-local capture the wake path
 * upgrades from fresh to `--resume`. Contract, enforced here:
 *
 * - **Local-only secrets.** The session id and transcript path land ONLY in the gitignored 0600
 *   `binding.json`. The daemon push (best-effort, after the local write) carries harness CLASS +
 *   event and nothing else — the wire schema has no field for an id or a path.
 * - **Presence-neutral, never claiming.** The push rides `presenceNeutral()` (ADR 057) and hits a
 *   route that touches no presence row and no claim (ADR 108) — a hook must never flip the roster
 *   or displace the live occupant.
 * - **A hook must never fail.** Missing stdin, no session_id, no binding, unreachable daemon — all
 *   exit 0 silently. The hook one-liner also `|| true`s, but capture being belt-and-braces about
 *   it keeps a broken capture from ever bleeding into a harness session.
 * - **Anchored writes.** The workspace root is resolved from the hook's stdin `cwd` (walking up to
 *   the `.musterd/binding.json` holder), never bare `process.cwd()` — the ambient-cwd clobber
 *   (ADR 018) is exactly a hook-shaped process writing a sibling worktree's binding.
 *
 * `show` is the human/triage half: what is captured here, is it live, would a wake resume it.
 */
export async function sessionCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'start' || sub === 'end') return captureCommand(sub, parsed);
  if (sub === 'resolve-labels') return resolveLabelsCommand(parsed);
  if (sub === 'label-nudge') return labelNudgeCommand();
  if (sub === 'show' || sub === undefined) return showCommand(parsed);
  throw new CliError(
    'usage: musterd session start --stdin | end --stdin | resolve-labels --stdin | label-nudge | show  ' +
      '(start/end are hook-driven — `musterd init` provisions the hooks; humans want `show`)',
    2,
  );
}

/** The harness class this capture path serves. The hook JSON shape below is Claude Code's; other
 *  harnesses get their own capture route per the per-class contract (design doc §3). */
const CAPTURE_HARNESS = 'claude-code';

/** Drain stdin with a hard timeout — a hook wiring mistake (no JSON piped) must not hang a shell. */
function readStdin(timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const done = (): void => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

/** The fields we use from the harness hook payload — parsed leniently, unknown fields ignored. */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

function parseHookPayload(raw: string): HookPayload {
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== 'object' || json === null) return {};
    const o = json as Record<string, unknown>;
    return {
      ...(typeof o['session_id'] === 'string' ? { session_id: o['session_id'] } : {}),
      ...(typeof o['transcript_path'] === 'string'
        ? { transcript_path: o['transcript_path'] }
        : {}),
      ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'] } : {}),
    };
  } catch {
    return {};
  }
}

async function captureCommand(event: 'start' | 'end', parsed: Parsed): Promise<number> {
  if (parsed.flags['stdin'] !== true) {
    throw new CliError(
      `usage: musterd session ${event} --stdin  — hook-driven: pipe the harness's hook JSON in ` +
        '(`musterd init` wires the hooks); to inspect this workspace, use `musterd session show`',
      2,
    );
  }
  await captureSession(event, parseHookPayload(await readStdin()));
  return 0;
}

/**
 * Is a session running here that the capture slot does not name? — the ADR 166 question, asked of
 * one reader that never asked it.
 *
 * `binding.session` is written only by the SessionStart hook. When that hook does not write for a
 * new session, the predecessor's block survives with its `ended_at` intact, and every later reader
 * concludes the live seat has ended. Enumerated session files are the stronger witness (ADR 166
 * "THE FLIP"), so they settle it: a transcript in this workspace being appended to *right now*,
 * whose id is not the captured one, means the slot is a corpse and names where the truth is.
 *
 * Returns the live session's transcript when the slot is contradicted, else undefined. Read-only,
 * best-effort, and silent on any failure — it rides a hook.
 */
function liveSessionElsewhere(
  dir: string,
  session: SessionCapture,
  now: number,
  enumerate: typeof enumerateClaudeSessions,
): { path: string; id: string } | undefined {
  try {
    const files = enumerate(dir);
    if (!files) return undefined; // the harness cannot enumerate — the slot stays the only witness
    const live = files.find((f) => now - f.mtime < LOCAL_SESSION_LIVE_MS && f.id !== session.id);
    return live ? { path: live.path, id: live.id } : undefined;
  } catch {
    return undefined;
  }
}

/** When a healed slot's session began: the transcript file appears at session start, so its
 *  birthtime is the honest `started_at`. Undefined on any stat failure — it rides a hook.
 *
 *  FLOORED, and that is load-bearing: `birthtimeMs` is fractional, while `SessionCaptureSchema`
 *  declares `started_at` as `z.number().int()`. Handing the float straight through wrote a binding
 *  that `readBinding` could no longer parse, so `findBinding` returned null for that workspace
 *  forever and every CLI path that resolves identity through it died silently — including this
 *  refresh, at its own first guard. TypeScript cannot see the difference: `.int()` is a runtime
 *  refinement on a field the type system only knows as `number`. */
function birthtimeOf(path: string): number | undefined {
  try {
    const t = statSync(path).birthtimeMs;
    return Number.isFinite(t) && t > 0 ? Math.floor(t) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask the harness that owns this capture what model it is actually running. Never throws: a probe
 * failure must not fail a hook, and `undefined` simply falls through to the declared tier.
 */
function observeModelFor(harnessId: string, payload: HookPayload): string | undefined {
  try {
    return HARNESSES.find((h) => h.id === harnessId)?.observeModel?.({
      ...(payload.transcript_path ? { transcript_path: payload.transcript_path } : {}),
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * The capture itself, stdin-free (exported for tests + the e2e harness): resolve the workspace,
 * write/annotate `binding.session`, then push the harness-class-only attestation best-effort.
 */
export async function captureSession(event: 'start' | 'end', payload: HookPayload): Promise<void> {
  if (!payload.session_id) return; // no id, nothing to capture — a hook must never fail

  // Resolve the workspace: an explicit MUSTERD_BINDING (the harness env rides through the hook)
  // wins, else walk up from the hook-reported cwd. Bare process.cwd() is only the last resort —
  // the hook one-liner cd's to CLAUDE_PROJECT_DIR, so it agrees with `payload.cwd` anyway.
  const explicit = process.env['MUSTERD_BINDING'];
  const dir = explicit
    ? dirname(dirname(explicit))
    : findWorkspaceDir(payload.cwd ?? process.cwd());
  if (!dir) return; // not a musterd workspace — nothing to capture

  const binding = findBinding(dir, {});
  if (!binding) return;

  let session: SessionCapture;
  if (event === 'start') {
    session = {
      harness: CAPTURE_HARNESS,
      id: payload.session_id,
      ...(payload.transcript_path ? { transcript_path: payload.transcript_path } : {}),
      started_at: Date.now(),
    };
  } else {
    // SessionEnd is advisory: only annotate the capture it belongs to. A mismatched id means the
    // ending session was never captured here (or a newer one already overwrote it) — leave it be.
    if (!binding.session || binding.session.id !== payload.session_id) return;
    session = { ...binding.session, ended_at: Date.now() };
  }

  // The model observation. Additive and best-effort: only SessionStart observes (SessionEnd is
  // advisory and may fire long after the model is knowable), and a harness that cannot observe — or
  // a transcript that is missing or has moved format — leaves any PRIOR observation in place rather
  // than erasing it. Losing a good observation to one bad read would re-open the very lie this
  // closes: the roster would silently fall back to a stale declaration.
  //
  // Expect this to observe NOTHING on a fresh session: the transcript named here is the new one, and
  // it carries no assistant turn yet. `refreshModelObservation` below is what actually lands the
  // observation, at the first tool boundary — this call only catches a resumed transcript.
  const observed = event === 'start' ? observeModelFor(CAPTURE_HARNESS, payload) : undefined;
  const model_observed = observed
    ? { model: observed, harness: CAPTURE_HARNESS, observed_at: Date.now() }
    : binding.model_observed;

  saveBinding(dir, { ...binding, session, ...(model_observed ? { model_observed } : {}) });

  // The resumable attestation (harness class only), best-effort AFTER the durable local write:
  // a dead daemon must never fail the hook, and capture is complete without it.
  const seat = bindingSeat(binding);
  if (binding.agent_key && seat) {
    try {
      const http = new HttpClient({
        server: binding.server,
        key: binding.agent_key,
      }).presenceNeutral();
      await http.attestSession(binding.team, { seat, harness: CAPTURE_HARNESS, event });
    } catch {
      // unreachable daemon / auth drift — the local capture stands; `residency status` names drift
    }
  }
}

/**
 * How long an observation stands before the next tool boundary re-reads the transcript. Bounds two
 * opposite failures: too short and every tool call pays a 256 KiB tail read; too long and a
 * mid-session `/model` switch attests the old model for the rest of the run.
 */
export const OBSERVATION_REFRESH_MS = 5 * 60_000;

/**
 * Re-observe the running model from the captured transcript (ADR 158 follow-up).
 *
 * SessionStart is the wrong and only moment `captureSession` observes: the transcript it is handed
 * is the *new* session's, which has no assistant turn yet, so `observeModel` returns `undefined`
 * every single time and the deliberate never-erase fallback pins the previous observation forever.
 * Two lies come out of that, and this closes both:
 *
 * - **The carry-forward.** A seat that switched models between sessions attests the old one for the
 *   whole new session — the stale declaration ADR 158 set out to kill, relocated one field over.
 * - **The mid-session switch.** `readModelFromTranscript` walks backwards precisely so a run that
 *   switched models attests the one it is running *now*; observing once, at the start, threw that away.
 *
 * Runs at the tool boundary (the PostToolUse interrupt hook), where the transcript is guaranteed to
 * carry at least one assistant turn. Cheap by construction: a bounded tail read, at most once per
 * `OBSERVATION_REFRESH_MS`, skipped entirely once the observation is current. Never throws and never
 * erases — same hook contract as capture. Returns the newly written model, or `undefined` for "no
 * change", which is the overwhelmingly common path.
 */
export function refreshModelObservation(
  dirHint?: string,
  // Injected for tests, mirroring `localSessionLiveness` — the enumerator reads the real
  // ~/.claude/projects tree, which a unit test must not depend on.
  enumerate: typeof enumerateClaudeSessions = enumerateClaudeSessions,
): string | undefined {
  try {
    const dir = dirHint ?? findWorkspaceDir();
    if (!dir) return undefined;
    const binding = findBinding(dir, {});
    const session = binding?.session;
    if (!binding || !session?.transcript_path) return undefined;

    // Only a live captured session has a transcript worth re-reading — but "ended" is a claim by the
    // SLOT, and ADR 166 already established that the slot is the weaker witness: enumerated session
    // files decide, because "a workspace with a live session and a newer dead one is exactly the case
    // the slot gets wrong". This reader never got that flip, and the cost is specific.
    //
    // The capture is only replaced by a SessionStart hook. When that hook does not write for a new
    // session — measured live on 2026-07-29: 3 of 5 active seats carried a predecessor's block, one
    // of them 16 days old — the corpse stays on disk with `ended_at` set, and every later read
    // concludes the LIVE seat has ended. Bailing here then silently retires model *observation* for
    // the rest of that seat's life, so attestation falls back to the stale declaration: ADR 163's
    // named failure, "worse, because it looks trustworthy".
    //
    // So an ended slot ends the refresh only when nothing contradicts it. If the workspace has a
    // live session that the slot does not name, the slot is a corpse and the live transcript is the
    // one worth reading.
    const now = Date.now();
    const live = liveSessionElsewhere(dir, session, now, enumerate);
    if (session.ended_at !== undefined && !live) return undefined;

    // The heal (lane 01KYQF0STK). An ended slot contradicted by a live session is not just a bad
    // witness to route around — it is a corpse that keeps doing damage: `session show` reports the
    // seat ended, and the wake ladder resumes the BLIP's transcript, because a valid-but-wrong slot
    // id outranks enumeration. The route table proved SessionStart fires on every spawn route; the
    // corpse gets there by being written LAST — a short concurrent session (a wake beside an
    // idle-but-open interactive session) steals the slot and stamps `ended_at`, and the long-lived
    // session never fires SessionStart again to take it back. So the tool boundary — the boundary
    // that always happens — gives the slot to the session that is actually running. `started_at`
    // comes from the transcript's birthtime (the file appears when the session begins); the heal is
    // scoped to ended-and-contradicted, so live-beside-live co-tenancy is left to the wake guard.
    let healedBinding = binding;
    let slot = session;
    // Tracked beside the slot because `SessionCapture.transcript_path` is optional in the type while
    // the guard above has already made it present here — and the heal below only ever replaces it
    // with another concrete path.
    let slotTranscript = session.transcript_path;
    if (session.ended_at !== undefined && live) {
      slot = {
        harness: session.harness,
        id: live.id,
        transcript_path: live.path,
        started_at: birthtimeOf(live.path) ?? now,
      };
      slotTranscript = live.path;
      healedBinding = { ...binding, session: slot };
      saveBinding(dir, healedBinding);
    }

    const prior = healedBinding.model_observed;
    // Current already? Two ways to be stale: observed before this session began (the carry-forward),
    // or simply old enough that a mid-run switch could have happened since.
    const current =
      prior !== undefined &&
      prior.observed_at >= slot.started_at &&
      now - prior.observed_at < OBSERVATION_REFRESH_MS;
    if (current) return undefined;

    // The harness that captured the session owns the parse — a codex-captured session must not be
    // read with Claude Code's eyes.
    const harness = slot.harness;
    // Read from the SLOT — which the heal above has already pointed at the live session if the
    // captured one turned out to be a corpse. Preferring `live` directly instead was a scope error
    // with the same shape as the bug it was fixing, one step further out: `liveSessionElsewhere` is
    // any transcript in the project dir touched inside LOCAL_SESSION_LIVE_MS, so a HEALTHY slot was
    // overridden by whichever neighbour happened to be warm. Measured on izzo, 2026-07-29 — a seat
    // that closed one session and opened another three minutes later attested the predecessor's
    // model four seconds in, which is precisely where a *different* model is most likely to be read.
    const observed = observeModelFor(harness, {
      transcript_path: slotTranscript,
      session_id: slot.id,
    });
    if (!observed) return undefined; // unreadable / moved format — the prior observation stands

    saveBinding(dir, {
      ...healedBinding,
      model_observed: { model: observed, harness, observed_at: now },
    });
    return observed;
  } catch {
    return undefined; // rides a hook: a refresh must never fail the tool call it hangs off
  }
}

// ---------------------------------------------------------------------------------------------
// `session resolve-labels` — the sidebar-sweep decision engine (ADR 160, surface 2)
// ---------------------------------------------------------------------------------------------

/** One row of the harness's session list, parsed leniently — unknown fields ignored. */
export interface SessionRow {
  sessionId?: string;
  title?: string;
  cwd?: string;
  isArchived?: boolean;
  /** ISO timestamp of last activity — the degraded stand-in for `createdAt` (see below). */
  lastActivityAt?: string;
}

export interface ResolveLabelsResult {
  apply: { session_id: string; seat: string; title: string }[];
  skipped: Record<string, number>;
}

/**
 * A brand-new session's title is still a first guess off the opening prompt; wait for the harness's
 * real auto-title before pinning a prefix on it.
 */
const LABEL_MIN_AGE_MS = 120_000;

/**
 * Where Claude Code Desktop keeps its own session records (`createdAt`, `titleSource`). Undocumented
 * and version-fragile, so strictly best-effort enrichment: `MUSTERD_CCD_SESSIONS_DIR` overrides, and
 * every read degrades to the session row itself. The worst failure is a mis-dated label or a missed
 * skip — never corruption, since the original title always survives as the label's suffix.
 */
function ccdSessionsDir(env: NodeJS.ProcessEnv): string {
  return (
    env['MUSTERD_CCD_SESSIONS_DIR'] ??
    join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
  );
}

/** The desktop app's record for a session: created-at (ms) + who last set the title. */
function ccdMeta(dir: string, sessionId: string): { createdAt?: number; titleSource?: string } {
  try {
    for (const org of readdirSync(dir)) {
      const orgDir = join(dir, org);
      let inner: string[];
      try {
        inner = readdirSync(orgDir);
      } catch {
        continue;
      }
      for (const proj of inner) {
        const p = join(orgDir, proj, `${sessionId}.json`);
        if (!existsSync(p)) continue;
        const rec = JSON.parse(readFileSync(p, 'utf8')) as {
          createdAt?: number;
          titleSource?: string;
        };
        return {
          ...(rec.createdAt !== undefined ? { createdAt: rec.createdAt } : {}),
          ...(rec.titleSource !== undefined ? { titleSource: rec.titleSource } : {}),
        };
      }
    }
  } catch {
    // dir missing/moved — degrade to the session row
  }
  return {};
}

/**
 * The seat behind a session's cwd, or null when it is not a seat workspace. The committed
 * `workspace.json` claim is authoritative (walk-up, so a session parked in a subfolder still
 * resolves); an `agents-<name>` folder without a seat claim (role/chat binding) falls back to the
 * folder suffix rather than dropping the session.
 */
function seatForCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const spec = findWorkspaceSpec(cwd);
  if (spec?.claim?.mode === 'seat') return spec.claim.name;
  const m = /^agents[-_](.+)$/.exec(basename(cwd.replace(/\/+$/, '')));
  return m ? m[1]! : null;
}

/**
 * The pure sweep decision: which sessions get which titles, and why the rest were skipped. The
 * caller (a harness-side agent, via the label-sessions guidance skill) applies the renames — this
 * engine never writes anything. Invariants, proven by the personal sweep this productizes:
 *
 * - `titleSource: "user"` is inviolable for a title in the human's OWN terms — their words outrank
 *   the sweep, always. Narrowed (ADR 160 amendment): a title the human already wrote in seat form
 *   ("Miley - fix(x)") says what the sweep says, so it is completed — chip and timestamp added,
 *   their words carried through verbatim — rather than skipped. The original ordering ran this
 *   guard before the seat parse, which made the upgrade branch below unreachable for exactly the
 *   rows that needed it and turned hand-renaming into a permanent opt-out.
 * - Idempotent via `parseSeatLabel`: fully-labeled rows skip; seat-prefixed rows that already carry
 *   a stamp (a pre-chip sweep's work) get the chip prepended with their ORIGINAL timestamp text
 *   kept — re-rendering would re-date history; seat-prefixed rows with no stamp are re-rendered
 *   around their subject, which is what gives a hand-named row its missing time.
 * - Freshness gates on `createdAt`, and — unlike the python original, which skipped the gate on
 *   its fallback branch — also on `lastActivityAt` when the app's record is unreadable.
 */
export function resolveLabels(
  sessions: SessionRow[],
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {},
): ResolveLabelsResult {
  const now = opts.now ?? Date.now();
  const dir = ccdSessionsDir(opts.env ?? process.env);
  const apply: ResolveLabelsResult['apply'] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const s of sessions) {
    const title = (s.title ?? '').trim();
    if (s.isArchived) {
      skip('archived');
      continue;
    }
    if (!title || !s.sessionId) {
      skip('no-title-yet');
      continue;
    }
    const seat = seatForCwd(s.cwd);
    if (!seat) {
      skip('not-a-seat');
      continue;
    }
    const meta = ccdMeta(dir, s.sessionId);
    const parse = parseSeatLabel(title, seat);
    if (parse.chipped && parse.seated) {
      skip('already-labeled');
      continue;
    }
    // The user-title guard, NARROWED (ADR 160 amendment). "A title the user typed is never
    // overwritten" still holds for anything the human wrote in their own terms. But a title the
    // human already wrote in *seat form* — "Miley - fix(broadcast)" — states exactly what this
    // sweep states; completing it (chip, timestamp, their words verbatim) is finishing their
    // sentence, not overruling it. The guard used to run BEFORE the seat parse, which made the
    // chip-upgrade branch below unreachable in practice: a chipless seat-prefixed title is almost
    // always one a human typed, so the rows most in need of upgrading were the ones permanently
    // skipped — and hand-renaming, the workaround for an unlabeled sidebar, silently opted a
    // session out of ever being labeled again.
    //
    // MEASURED CEILING (2026-07-27): on Claude Code Desktop this narrowing is inert, because the
    // app's own rename tool refuses a user-titled session and reports success anyway. Our guard was
    // redundant with the harness's. What survives is the non-user case (an earlier sweep's output,
    // or an auto-title that leads with the seat) plus the dated/subject/boundary fixes below. Keep
    // the narrowing — it is right, and other surfaces may not have the app's guard — but do not
    // expect it to reclaim a row a human renamed by hand.
    if (meta.titleSource === 'user' && !parse.seated) {
      skip('hand-named');
      continue;
    }
    if (parse.seated && parse.dated) {
      // Pre-chip label: prepend the chip, keep the original "(Fri 3p)" text — never re-date.
      apply.push({
        session_id: s.sessionId,
        seat: capitalizeSeat(seat),
        title: `${SEAT_CHIP} ${parse.bare}`,
      });
      continue;
    }
    const createdMs =
      meta.createdAt ?? (s.lastActivityAt ? Date.parse(s.lastActivityAt) : undefined);
    if (createdMs === undefined || Number.isNaN(createdMs)) {
      skip('no-timestamp');
      continue;
    }
    if (now - createdMs < LABEL_MIN_AGE_MS) {
      skip('too-fresh');
      continue;
    }
    apply.push({
      session_id: s.sessionId,
      seat: capitalizeSeat(seat),
      // `subject`, not `bare`: a hand-seated title ("Miley - fix(x)") must not be re-seated into
      // "🔶 Miley (Sun 9p) - Miley - fix(x)". For an unseated title the two are identical.
      title: renderSeatLabel(seat, createdMs, parse.subject, now),
    });
  }

  return { apply, skipped };
}

// ---------------------------------------------------------------------------------------------
// The label-sweep nudge rail. The sweep only happens when a harness-side agent runs it, and the
// one-shot SessionStart instruction was measured to fail: agents skip it under a busy first prompt
// (3 days of unlabeled sidebar, 2026-07-29). So the ask repeats — the UserPromptSubmit hook calls
// `label-nudge` every turn — but self-quiets: `resolve-labels` stamps a machine-wide "last sweep"
// file, and the nudge prints ONLY while that stamp is missing or stale. One seat's sweep silences
// every seat's nudge; nothing depends on the nudged session being the one that complies.
// ---------------------------------------------------------------------------------------------

/** How stale the machine-wide sweep stamp may get before the nudge re-arms. Long enough that a
 *  sweep quiets a whole working session; short enough that new sessions never wait a day. */
export const LABEL_SWEEP_STALE_MS = 4 * 3_600_000;

/** Machine-wide (not per-workspace): a sweep labels every seat's sessions, so one stamp serves
 *  all. Env-overridable for tests, like `MUSTERD_CCD_SESSIONS_DIR` above. */
function labelStampPath(env: NodeJS.ProcessEnv): string {
  return env['MUSTERD_LABEL_STAMP'] ?? join(homedir(), '.musterd', 'label-sweep.json');
}

/** Record "a sweep ran now". Best-effort: rides a hook-adjacent path, so it must never throw. */
export function stampLabelSweep(now = Date.now(), env: NodeJS.ProcessEnv = process.env): void {
  try {
    const p = labelStampPath(env);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ swept_at: now }) + '\n', 'utf8');
  } catch {
    // a failed stamp costs one extra nudge, never a broken sweep
  }
}

/** True when the nudge should fire: no stamp, an unreadable stamp, or a stale one. */
export function labelSweepDue(now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const rec = JSON.parse(readFileSync(labelStampPath(env), 'utf8')) as { swept_at?: unknown };
    return typeof rec.swept_at !== 'number' || now - rec.swept_at >= LABEL_SWEEP_STALE_MS;
  } catch {
    return true;
  }
}

/** `session label-nudge` — hook-driven, hence silent-or-one-line and never failing. */
function labelNudgeCommand(): number {
  try {
    if (labelSweepDue()) {
      process.stdout.write(
        'musterd: the sidebar label sweep has not run recently — run the musterd-label-sessions ' +
          'skill NOW, before continuing the task (list sessions, pipe through `musterd session ' +
          'resolve-labels --stdin`, apply the renames). One sweep labels every seat session and ' +
          'quiets this nudge machine-wide.\n',
      );
    }
  } catch {
    // hook contract: never fail, never noise
  }
  return 0;
}

/** The stdin wrapper: harness session-list JSON in, `{apply, skipped}` JSON out. */
async function resolveLabelsCommand(parsed: Parsed): Promise<number> {
  if (parsed.flags['stdin'] !== true) {
    throw new CliError('usage: musterd session resolve-labels --stdin  (session-list JSON in)', 2);
  }
  const raw = await readStdin();
  let sessions: SessionRow[];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('not an array');
    sessions = data as SessionRow[];
  } catch {
    throw new CliError('resolve-labels: stdin must be a JSON array of session rows', 2);
  }
  process.stdout.write(JSON.stringify(resolveLabels(sessions), null, 1) + '\n');
  // The sweep ran (even if `apply` came back empty — "checked, nothing to do" is still a sweep):
  // stamp it, so `label-nudge` goes quiet machine-wide.
  stampLabelSweep();
  return 0;
}

/** The acted-on verdict line, with its source (ADR 166: enumerated decides when available). */
function writeVerdict(liveness: LocalSessionLiveness): 0 {
  const verdicts: Record<LocalSessionLiveness['state'], string> = {
    live: `live — a local session is working here (transcript touched < ${LOCAL_SESSION_LIVE_MS / 60_000} min ago); a wake would defer`,
    resumable: 'resumable — a wake would try `--resume` first (fresh on any failure)',
    'gc-expired': 'gc-expired — past the harness GC horizon; a wake runs fresh',
    none: 'none',
  };
  process.stdout.write(
    `  ${theme.accent(verdicts[liveness.state])} ${theme.meta(`(judged by ${liveness.source === 'enumerated' ? 'session files' : 'the captured slot'})`)}\n`,
  );
  return 0;
}

async function showCommand(parsed: Parsed): Promise<number> {
  const dir = findWorkspaceDir();
  const liveness: LocalSessionLiveness = dir
    ? localSessionLiveness(dir)
    : { state: 'none', source: 'slot' };

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ workspace: dir, ...liveness }) + '\n');
    return 0;
  }
  if (!dir) {
    process.stdout.write(
      theme.meta('no workspace here (no .musterd/binding.json on the walk-up)') + '\n',
    );
    return 0;
  }
  process.stdout.write(`${theme.accent('session')} — ${dir}\n`);
  // ADR 166 inc 2: the verdict can be enumerated with no slot capture at all — say what the
  // harness's own session files show before (or instead of) describing the capture.
  if (liveness.source === 'enumerated' && liveness.enumerated) {
    const e = liveness.enumerated;
    process.stdout.write(
      `  ${theme.meta('sessions')} ${e.count} on disk` +
        (e.id !== undefined ? `  ${theme.meta('newest')} ${e.id}` : '') +
        (e.mtime !== undefined ? ` (touched ${clock(e.mtime)})` : '') +
        '\n',
    );
  }
  const s = liveness.session;
  if (!s) {
    process.stdout.write(
      theme.meta(
        'no captured session — start a harness session here (the SessionStart hook captures it), ' +
          'or run `musterd init --check` if hooks may be missing',
      ) + '\n',
    );
    return writeVerdict(liveness);
  }
  process.stdout.write(
    `  ${theme.meta('harness')} ${s.harness}  ${theme.meta('id')} ${s.id}\n` +
      `  ${theme.meta('started')} ${clock(s.started_at)}` +
      (s.ended_at !== undefined ? `  ${theme.meta('ended')} ${clock(s.ended_at)}` : '') +
      '\n',
  );
  if (s.transcript_path) {
    const size =
      liveness.transcriptBytes !== undefined
        ? `${(liveness.transcriptBytes / 1024).toFixed(0)} KiB`
        : 'missing';
    const touched =
      liveness.transcriptMtime !== undefined ? `touched ${clock(liveness.transcriptMtime)}` : '';
    process.stdout.write(
      `  ${theme.meta('transcript')} ${s.transcript_path} (${size}) ${touched}\n`,
    );
  }
  writeVerdict(liveness);
  // `--seat`-style flags are meaningless here; nudge a confused caller toward the right verb.
  if (flagStr(parsed.flags, 'seat')) {
    process.stdout.write(
      theme.meta(
        '(session show reads THIS workspace; for enrollment state use `musterd residency status`)',
      ) + '\n',
    );
  }
  return 0;
}
