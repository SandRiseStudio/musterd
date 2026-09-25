import { TraceEventKindSchema, type TraceSessionEvent } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { findBinding } from '../config.js';
import { CliError } from '../errors.js';
import { readHookStdin } from '../hookStdin.js';
import { theme } from '../render/theme.js';
import { sessionDigest } from '../session/digest.js';
import { tapHook } from '../trace/hook.js';
import { tailTranscript } from '../trace/tail.js';
import { findWorkspaceDir, resolveRead } from './helpers.js';

/**
 * `musterd trace` — the trace tap's CLI surface (ADR 445).
 *
 * `trace hook --stdin [--harness <id>] [--kind <TraceEventKind>]` — the standalone hook tap
 * (increment 1a), registered on the Claude Code events no existing musterd hook already rides:
 * `UserPromptSubmit`, `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`.
 * The events that already spawn a musterd process (PreToolUse → gate, PostToolUse → interrupt
 * probe, SessionStart/End → capture) tap from inside those commands instead, so the per-call cost
 * stays what the gate costs now (ADR 445 §Consequences). On `Stop` and `SessionEnd` the same
 * process also runs the rail R2 transcript tail (increment 2): the turn just ended, so its
 * reasoning and usage are on disk, and this is the delta read that picks them up.
 *
 * Exit code for `hook` is always 0. A hook that can fail a turn is a regression; this one records
 * or it does not, and says nothing either way.
 *
 * `trace show [<session-id | digest>]` — one session end to end (increment 2): rail R1 hook events
 * and rail R2 transcript records interleaved in daemon sequence order. With no argument, the
 * workspace's captured session. A raw harness session id is digested locally with the workspace's
 * agent key — the id itself never crosses the wire (ADR 131 §5).
 */
export async function traceCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'show') return traceShow(parsed);
  if (sub !== 'hook') {
    throw new CliError(
      'usage: musterd trace hook --stdin  |  musterd trace show [<session-id | digest>]',
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
    const binding = findBinding(dir);
    const harness = flagStr(parsed.flags, 'harness') ?? 'claude-code';
    await tapHook(raw, {
      binding,
      dir,
      harness,
      ...(kind?.success ? { kind: kind.data } : {}),
    });
    await tailAfterHook(raw, {
      binding,
      dir,
      harness,
      kind: kind?.success ? kind.data : undefined,
    });
  } catch {
    // fail-open by contract
  }
  return 0;
}

/**
 * Rail R2 rides the turn-boundary hooks: after the tap, a `Stop` or `SessionEnd` payload that
 * names a transcript runs the delta read. Bounded and silent like the tap itself.
 */
async function tailAfterHook(
  raw: string,
  opts: {
    binding: ReturnType<typeof findBinding>;
    dir: string;
    harness: string;
    kind?: string | undefined;
  },
): Promise<void> {
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== 'object' || o === null) return;
    const payload = o as Record<string, unknown>;
    const kind = opts.kind ?? payload['hook_event_name'];
    if (kind !== 'Stop' && kind !== 'SessionEnd') return;
    const sessionId = payload['session_id'];
    const transcriptPath = payload['transcript_path'];
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (typeof transcriptPath !== 'string' || !transcriptPath) return;
    await tailTranscript({
      binding: opts.binding,
      dir: opts.dir,
      harness: opts.harness,
      sessionId,
      transcriptPath,
    });
  } catch {
    /* fail-open by contract */
  }
}

async function traceShow(parsed: Parsed): Promise<number> {
  const dir = findWorkspaceDir() ?? process.cwd();
  const binding = findBinding(dir);
  const arg = parsed.positionals[1];
  let digest: string;
  if (arg && /^[0-9a-f]{8,32}$/.test(arg)) {
    digest = arg;
  } else {
    const sessionId = arg ?? binding?.session?.id;
    if (!sessionId) {
      throw new CliError(
        'no session — pass a harness session id or digest, or run from a workspace with a captured session',
        2,
      );
    }
    if (!binding?.agent_key) {
      throw new CliError(
        'this workspace has no agent key, so a raw session id cannot be digested — pass the digest instead',
        2,
      );
    }
    digest = sessionDigest(binding.agent_key, sessionId);
  }
  const { team, http } = resolveRead(parsed.flags);
  const { events } = await http.getTraceSession(team, digest);
  if (parsed.flags['json'] === true) {
    process.stdout.write(JSON.stringify({ digest, events }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(renderTraceSession(digest, events) + '\n');
  return 0;
}

const clockSec = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** First line of a content field, bounded — a preview, never the record. */
function preview(text: unknown, max = 96): string {
  if (typeof text !== 'string' || !text) return '';
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** One row's right-hand cell: what happened, in the kind's own vocabulary. */
export function traceEventSummary(e: TraceSessionEvent): string {
  const d = e.detail ?? {};
  if (e.kind === 'usage') {
    const parts: string[] = [];
    const inTok = num(d['input_tokens']);
    const outTok = num(d['output_tokens']);
    const cache = num(d['cache_read_tokens']);
    if (inTok !== undefined) parts.push(`in ${inTok}`);
    if (cache !== undefined && cache > 0) parts.push(`cache ${cache}`);
    if (outTok !== undefined) parts.push(`out ${outTok}`);
    const model = typeof d['model'] === 'string' ? d['model'] : undefined;
    return [parts.join(' · '), model].filter(Boolean).join('  ');
  }
  if (e.kind === 'reasoning' || e.kind === 'assistant_text') {
    const text = preview(e.content?.[e.kind === 'reasoning' ? 'reasoning' : 'assistant']);
    if (text) return text;
    const size = num(d[e.kind === 'reasoning' ? 'reasoning_bytes' : 'assistant_bytes']);
    return size !== undefined ? `${size} bytes (structural)` : '';
  }
  if (e.kind === 'unknown') {
    const type = typeof d['type'] === 'string' ? d['type'] : 'unparsed';
    return d['downgraded'] === true ? `DOWNGRADED — ${String(d['reason'] ?? '')}` : type;
  }
  if (e.kind === 'HookOutcome') {
    const hook = typeof d['hook'] === 'string' ? d['hook'] : '';
    return [hook, e.outcome ?? ''].filter(Boolean).join(' · ');
  }
  const bits: string[] = [];
  if (e.tool_name) bits.push(e.tool_name);
  if (typeof e.duration_ms === 'number') bits.push(`${e.duration_ms}ms`);
  if (e.outcome && e.outcome !== 'ok') bits.push(e.outcome);
  return bits.join(' · ');
}

/** The whole-session render: a header, then one line per event in sequence order. */
export function renderTraceSession(digest: string, events: TraceSessionEvent[]): string {
  if (events.length === 0) {
    return theme.meta(`session ${digest} — no trace events (not recorded, or not yours to read)`);
  }
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const spanMs = last.ts - first.ts;
  const spanMin = Math.round(spanMs / 60_000);
  const lines: string[] = [
    theme.bold(`session ${digest}`) +
      theme.meta(
        `  ${first.harness} · seat ${first.seat} · ${events.length} events · ` +
          (spanMin > 0 ? `${spanMin}m` : `${Math.max(1, Math.round(spanMs / 1000))}s`),
      ),
  ];
  for (const e of events) {
    const kindLabel =
      e.kind === 'reasoning' || e.kind === 'assistant_text' || e.kind === 'usage'
        ? theme.dim(e.kind.padEnd(18))
        : e.kind === 'unknown'
          ? theme.warn(e.kind.padEnd(18))
          : e.kind.padEnd(18);
    const summary = traceEventSummary(e);
    lines.push(
      `${theme.meta(String(e.seq).padStart(5))} ${theme.meta(clockSec(e.ts))} ${kindLabel} ${
        e.kind === 'reasoning' || e.kind === 'assistant_text' ? theme.dim(summary) : summary
      }`.trimEnd(),
    );
  }
  return lines.join('\n');
}
