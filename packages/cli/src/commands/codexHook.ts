import {
  bindingSeat,
  parseCodexHookEvent,
  resolveAttestedWakeLease,
  type Binding,
  type CodexHookEvent,
} from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import { sessionDigest } from '../session/digest.js';
import { findWorkspaceDir } from './helpers.js';

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

async function attest(binding: Binding, sessionId: string, event: 'start' | 'end'): Promise<void> {
  const seat = bindingSeat(binding);
  if (!binding.agent_key || !seat) return;
  try {
    const wakeLease = resolveAttestedWakeLease(process.env);
    await new HttpClient({ server: binding.server, key: binding.agent_key })
      .presenceNeutral()
      .attestSession(binding.team, {
        seat,
        harness: 'codex',
        event,
        session_digest: sessionDigest(binding.agent_key, sessionId),
        ...(wakeLease ? { wake_lease: wakeLease } : {}),
      });
  } catch {
    // A hook's local evidence remains valid when the daemon is unavailable.
  }
}

async function captureStart(event: Extract<CodexHookEvent, { event: 'start' }>): Promise<void> {
  const local = localBinding(event.cwd);
  if (!local) return;
  saveBinding(local.dir, {
    ...local.binding,
    session: {
      harness: 'codex',
      id: event.session_id,
      ...(event.transcript_path ? { transcript_path: event.transcript_path } : {}),
      started_at: Date.now(),
    },
  });
  await attest(local.binding, event.session_id, 'start');
}

async function captureEnd(event: Extract<CodexHookEvent, { event: 'end' }>): Promise<void> {
  const local = localBinding(event.cwd);
  const session = local?.binding.session;
  if (!local || !session || session.harness !== 'codex' || session.id !== event.session_id) return;
  saveBinding(local.dir, { ...local.binding, session: { ...session, ended_at: Date.now() } });
  await attest(local.binding, session.id, 'end');
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
