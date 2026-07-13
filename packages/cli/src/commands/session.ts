import { dirname } from 'node:path';
import { bindingSeat, type SessionCapture } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
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
  if (sub === 'show' || sub === undefined) return showCommand(parsed);
  throw new CliError(
    'usage: musterd session start --stdin | end --stdin | show  ' +
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
  saveBinding(dir, { ...binding, session });

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

async function showCommand(parsed: Parsed): Promise<number> {
  const dir = findWorkspaceDir();
  const liveness: LocalSessionLiveness = dir ? localSessionLiveness(dir) : { state: 'none' };

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
  const s = liveness.session;
  if (!s) {
    process.stdout.write(
      theme.meta(
        'no captured session — start a harness session here (the SessionStart hook captures it), ' +
          'or run `musterd init --check` if hooks may be missing',
      ) + '\n',
    );
    return 0;
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
  const verdicts: Record<LocalSessionLiveness['state'], string> = {
    live: `live — a local session is working here (transcript touched < ${LOCAL_SESSION_LIVE_MS / 60_000} min ago); a wake would defer`,
    resumable: 'resumable — a wake would try `--resume` first (fresh on any failure)',
    'gc-expired': 'gc-expired — past the harness GC horizon; a wake runs fresh',
    none: 'none',
  };
  process.stdout.write(`  ${theme.accent(verdicts[liveness.state])}\n`);
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
