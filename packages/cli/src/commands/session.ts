import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  if (sub === 'show' || sub === undefined) return showCommand(parsed);
  throw new CliError(
    'usage: musterd session start --stdin | end --stdin | resolve-labels --stdin | show  ' +
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
export function refreshModelObservation(dirHint?: string): string | undefined {
  try {
    const dir = dirHint ?? findWorkspaceDir();
    if (!dir) return undefined;
    const binding = findBinding(dir, {});
    // Only a live captured session has a transcript worth re-reading. An ended one is over: whatever
    // it last attested is the truth about it, and a stale re-read would only muddy that.
    const session = binding?.session;
    if (!binding || !session?.transcript_path || session.ended_at !== undefined) return undefined;

    const prior = binding.model_observed;
    // Current already? Two ways to be stale: observed before this session began (the carry-forward),
    // or simply old enough that a mid-run switch could have happened since.
    const now = Date.now();
    const current =
      prior !== undefined &&
      prior.observed_at >= session.started_at &&
      now - prior.observed_at < OBSERVATION_REFRESH_MS;
    if (current) return undefined;

    // The harness that captured the session owns the parse — a codex-captured session must not be
    // read with Claude Code's eyes.
    const harness = session.harness;
    const observed = observeModelFor(harness, {
      transcript_path: session.transcript_path,
      session_id: session.id,
    });
    if (!observed) return undefined; // unreadable / moved format — the prior observation stands

    saveBinding(dir, {
      ...binding,
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
