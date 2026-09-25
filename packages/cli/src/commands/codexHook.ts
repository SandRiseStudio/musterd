import { parseCodexHookEvent, type Binding, type CodexHookEvent } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { findBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import { readHookStdin } from '../hookStdin.js';
import { tapHook } from '../trace/hook.js';
import { tailTranscript } from '../trace/tail.js';
import { findWorkspaceDir } from './helpers.js';
import { checkHookInterrupt, emitSessionOrientation, pushAttestation } from './session.js';
import { runSessionStartProbe, type SessionStartProbe } from './sessionProbe.js';

export type CodexHookDeps = {
  start?: (event: Extract<CodexHookEvent, { event: 'start' }>) => Promise<void> | void;
  end?: (event: Extract<CodexHookEvent, { event: 'end' }>) => Promise<void> | void;
  observe?: (event: Extract<CodexHookEvent, { event: 'post-tool-use' }>) => Promise<void> | void;
  interrupt?: (dir: string | null) => Promise<string | null> | string | null;
  probe?: SessionStartProbe;
  tap?: typeof tapHook;
  tail?: typeof tailTranscript;
};

type CodexHookCommand = 'start' | 'end' | 'post-tool-use';

function command(parsed: Parsed): CodexHookCommand {
  const value = parsed.positionals[0];
  if (value === 'start' || value === 'end' || value === 'post-tool-use') return value;
  throw new CliError('usage: musterd codex-hook <start|end|post-tool-use> --stdin', 2);
}

const readStdin = readHookStdin;

/** Best-effort Codex hook boundary: malformed or mismatched input is deliberately a no-op. */
export async function handleCodexHook(
  parsed: Parsed,
  raw: string,
  deps: CodexHookDeps = {},
): Promise<string | null> {
  const expected = command(parsed);
  const event = parseCodexHookEvent(raw, expected);
  if (!event) return null;
  // ADR 445 R1 — Codex shares Claude Code's payload spelling, so the harness is named here, never
  // inferred. Each tap comes after the hook's own job and is bounded and silent like every other.
  const tap = deps.tap ?? tapHook;
  if (event.event === 'start') {
    const workspace = localBinding(event.cwd)?.dir ?? event.cwd;
    await runSessionStartProbe(workspace, deps.probe);
    await (deps.start ?? captureStart)(event);
    await tapLocal(tap, raw, event.cwd, 'SessionStart');
    return null;
  }
  if (event.event === 'end') {
    await (deps.end ?? captureEnd)(event);
    await tapLocal(tap, raw, event.cwd, 'SessionEnd');
    await tailCodex(deps, event.cwd, event.session_id, event.transcript_path);
    return null;
  }
  await (deps.observe ?? observeModel)(event);
  const local = localBinding(event.cwd);
  if (!local) return null;
  let line: string | null = null;
  try {
    line = await (deps.interrupt ?? checkHookInterrupt)(local.dir);
  } catch {
    line = null;
  }
  await tap(raw, {
    binding: local.binding,
    dir: local.dir,
    harness: 'codex',
    kind: 'PostToolUse',
    outcome: { hook: 'interrupt', detail: { raised: line !== null } },
  });
  // ADR 445 R2 (increment 2) — Codex has no Stop hook, so the per-call hook is the turn-boundary
  // read: the rollout path was captured on the binding at SessionStart, and the delta since the
  // last read is what this call appended. Bounded and fail-open like the tap above.
  await tailCodex(deps, event.cwd, event.session_id, undefined);
  return formatCodexInterrupt(line);
}

/** The rail R2 delta read for a Codex session: the hook's own `transcript_path` when the event
 *  carries one (SessionEnd), else the one the SessionStart capture put on the binding. */
async function tailCodex(
  deps: CodexHookDeps,
  cwd: string,
  sessionId: string,
  transcriptPath: string | undefined,
): Promise<void> {
  const local = localBinding(cwd);
  if (!local) return;
  const session = local.binding.session;
  const path =
    transcriptPath ??
    (session?.harness === 'codex' && session.id === sessionId
      ? session.transcript_path
      : undefined);
  if (!path) return;
  await (deps.tail ?? tailTranscript)({
    binding: local.binding,
    dir: local.dir,
    harness: 'codex',
    sessionId,
    transcriptPath: path,
  });
}

async function tapLocal(
  tap: typeof tapHook,
  raw: string,
  cwd: string,
  kind: 'SessionStart' | 'SessionEnd',
): Promise<void> {
  const local = localBinding(cwd);
  if (!local) return;
  await tap(raw, { binding: local.binding, dir: local.dir, harness: 'codex', kind });
}

export async function codexHookCommand(parsed: Parsed): Promise<number> {
  command(parsed);
  if (parsed.flags['stdin'] !== true) {
    throw new CliError('usage: musterd codex-hook <start|end|post-tool-use> --stdin', 2);
  }
  const output = await handleCodexHook(parsed, await readStdin());
  if (output) process.stdout.write(output + '\n');
  return 0;
}

/** Codex PostToolUse context seam: null stays silent; a raised daemon line becomes structured context. */
export function formatCodexInterrupt(line: string | null): string | null {
  return line
    ? JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: line },
      })
    : null;
}

function localBinding(cwd: string): { dir: string; binding: Binding } | undefined {
  const explicit = process.env['MUSTERD_BINDING'];
  const dir = explicit ? findWorkspaceDir(explicit) : findWorkspaceDir(cwd);
  if (!dir) return undefined;
  const binding = findBinding(dir, {});
  return binding ? { dir, binding } : undefined;
}

async function captureStart(event: Extract<CodexHookEvent, { event: 'start' }>): Promise<void> {
  const local = localBinding(event.cwd);
  if (!local) return;
  const session = {
    harness: 'codex' as const,
    id: event.session_id,
    ...(event.transcript_path ? { transcript_path: event.transcript_path } : {}),
    started_at: Date.now(),
  };
  saveBinding(local.dir, { ...local.binding, session });
  // pushAttestation (session.ts, ADR 359 lane 01M1JBH9CR) — the previous inline attest() here sent
  // no seat and no session lease, so every call 401'd silently since this file was written; the
  // codex hooks never having fired before ADR 359 is the only reason that stayed invisible.
  await pushAttestation(local.binding, session, 'start', local.dir, 'codex');
  // ADR 333: Codex SessionStart stdout is developer context. Same block Claude emits; silent on fail.
  const orientation = await emitSessionOrientation(local.dir);
  if (orientation) process.stdout.write(orientation + '\n');
}

async function captureEnd(event: Extract<CodexHookEvent, { event: 'end' }>): Promise<void> {
  const local = localBinding(event.cwd);
  const session = local?.binding.session;
  if (!local || !session || session.harness !== 'codex' || session.id !== event.session_id) return;
  const ended = { ...session, ended_at: Date.now() };
  saveBinding(local.dir, { ...local.binding, session: ended });
  await pushAttestation(local.binding, ended, 'end', local.dir, 'codex');
}

async function observeModel(
  event: Extract<CodexHookEvent, { event: 'post-tool-use' }>,
): Promise<void> {
  const local = localBinding(event.cwd);
  if (!local) return;
  saveBinding(local.dir, {
    ...local.binding,
    model_observed: { model: event.model, harness: 'codex', observed_at: Date.now() },
  });
}
