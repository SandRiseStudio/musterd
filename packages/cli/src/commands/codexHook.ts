import { parseCodexHookEvent, type Binding, type CodexHookEvent } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { findBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import { findWorkspaceDir } from './helpers.js';
import { emitSessionOrientation, pushAttestation } from './session.js';

export type CodexHookDeps = {
  start?: (event: Extract<CodexHookEvent, { event: 'start' }>) => Promise<void> | void;
  end?: (event: Extract<CodexHookEvent, { event: 'end' }>) => Promise<void> | void;
  observe?: (event: Extract<CodexHookEvent, { event: 'post-tool-use' }>) => Promise<void> | void;
};

type CodexHookCommand = 'start' | 'end' | 'post-tool-use';

function command(parsed: Parsed): CodexHookCommand {
  const value = parsed.positionals[0];
  if (value === 'start' || value === 'end' || value === 'post-tool-use') return value;
  throw new CliError('usage: musterd codex-hook <start|end|post-tool-use> --stdin', 2);
}

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

/** Best-effort Codex hook boundary: malformed or mismatched input is deliberately a no-op. */
export async function handleCodexHook(
  parsed: Parsed,
  raw: string,
  deps: CodexHookDeps = {},
): Promise<void> {
  const expected = command(parsed);
  const event = parseCodexHookEvent(raw, expected);
  if (!event) return;
  if (event.event === 'start') await (deps.start ?? captureStart)(event);
  else if (event.event === 'end') await (deps.end ?? captureEnd)(event);
  else await (deps.observe ?? observeModel)(event);
}

export async function codexHookCommand(parsed: Parsed): Promise<number> {
  command(parsed);
  if (parsed.flags['stdin'] !== true) {
    throw new CliError('usage: musterd codex-hook <start|end|post-tool-use> --stdin', 2);
  }
  await handleCodexHook(parsed, await readStdin());
  return 0;
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
