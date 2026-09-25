import { TraceEventKindSchema } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { findBinding } from '../config.js';
import { CliError } from '../errors.js';
import { readHookStdin } from '../hookStdin.js';
import { tapHook } from '../trace/hook.js';
import { findWorkspaceDir } from './helpers.js';

/**
 * `musterd trace hook --stdin [--harness <id>] [--kind <TraceEventKind>]` — the standalone hook tap
 * (ADR 445 §2 R1, increment 1a), registered on the Claude Code events no existing musterd hook
 * already rides: `UserPromptSubmit`, `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`,
 * `PreCompact`. The events that already spawn a musterd process (PreToolUse → gate, PostToolUse →
 * interrupt probe, SessionStart/End → capture) tap from inside those commands instead, so the
 * per-call cost stays what the gate costs now (ADR 445 §Consequences).
 *
 * Exit code is always 0. A hook that can fail a turn is a regression; this one records or it does
 * not, and says nothing either way.
 */
export async function traceCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub !== 'hook') {
    throw new CliError(
      'usage: musterd trace hook --stdin [--harness <id>] [--kind <event>] — hook-driven ' +
        '(a harness hook pipes its JSON in; `musterd init` provisions the hooks)',
      2,
    );
  }
  if (parsed.flags['stdin'] !== true) {
    throw new CliError('usage: musterd trace hook --stdin — pipe the hook JSON in', 2);
  }
  try {
    const raw = await readHookStdin();
    const kindFlag = flagStr(parsed.flags, 'kind');
    const kind = kindFlag ? TraceEventKindSchema.safeParse(kindFlag) : undefined;
    const dir = findWorkspaceDir() ?? process.cwd();
    await tapHook(raw, {
      binding: findBinding(dir),
      dir,
      harness: flagStr(parsed.flags, 'harness') ?? 'claude-code',
      ...(kind?.success ? { kind: kind.data } : {}),
    });
  } catch {
    // fail-open by contract
  }
  return 0;
}
