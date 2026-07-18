import { isAbsolute, relative } from 'node:path';
import { type GateToolCall, matchEnforcement } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { resolveRead } from './helpers.js';

/**
 * `musterd gate check --stdin` (ADR 150 — structural inducement) — the PreToolUse enforcement gate.
 * A Claude Code PreToolUse hook pipes its `{tool_name, tool_input}` JSON in; this decides whether the
 * tool call proceeds. The whole path is **fail-open and best-effort**, exactly like the ADR 088
 * interrupt probe: any missing input, unbound folder, unreachable daemon, or unexpected error exits 0
 * (allow). An unfinished or unreachable gate must NEVER wedge a tool call — the ADR's guard metric.
 *
 * The flow keeps the common case free: the class table is matched CLIENT-side (one member-authed GET),
 * and an **undeclared** call returns before any POST — the overwhelming majority of tool calls incur one
 * cheap loopback GET and nothing else. Only a MATCHED call round-trips to `POST /gate`, where the daemon
 * adjudicates atomically and records the shapes-only decision row. The raw command/path used to match
 * never leaves the client except, on a match, as the `target` the daemon needs for the decision + a Gate
 * B ask body (never an audit row, ADR 051).
 */
export async function gateCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'check') return gateCheck(parsed);
  throw new CliError(
    'usage: musterd gate check --stdin  — hook-driven (a PreToolUse hook pipes the tool call in); ' +
      '`musterd init` provisions the hook',
    2,
  );
}

/** Drain stdin with a hard timeout — a hook wiring mistake (no JSON piped) must not hang a tool call. */
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

/**
 * Extract the gate's view of a Claude Code PreToolUse payload: the tool name, and either its target
 * path (`file_path`/`notebook_path` — Edit/Write/MultiEdit/NotebookEdit) or its command (Bash). Returns
 * null when there's nothing gate-relevant to match on (so the caller allows). Lenient — unknown fields
 * ignored, unknown tools yield a call with neither path nor command (never matches → allow).
 */
export function parseToolCall(raw: string): GateToolCall | null {
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== 'object' || json === null) return null;
    const o = json as Record<string, unknown>;
    const tool = typeof o['tool_name'] === 'string' ? o['tool_name'] : undefined;
    if (!tool) return null;
    const input =
      typeof o['tool_input'] === 'object' && o['tool_input'] !== null
        ? (o['tool_input'] as Record<string, unknown>)
        : {};
    const path =
      typeof input['file_path'] === 'string'
        ? input['file_path']
        : typeof input['notebook_path'] === 'string'
          ? input['notebook_path']
          : undefined;
    const command = typeof input['command'] === 'string' ? input['command'] : undefined;
    return { tool, ...(path ? { path } : {}), ...(command ? { command } : {}) };
  } catch {
    return null;
  }
}

/** Emit the PreToolUse deny control JSON Claude Code reads — the tool is blocked and `reason` is the
 *  repair string surfaced to the model (in its action loop, not its background context). */
function emitDeny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
}

/** Surface a warn-posture advisory without blocking or auto-granting. `additionalContext` proceeds
 *  normally and best-effort adds the note to the model's context; a Claude Code build that ignores it
 *  simply proceeds silently (warn's guaranteed half is the server-side audit row, not this surface). */
function emitWarn(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason },
    }) + '\n',
  );
}

/**
 * Make a tool's target path repo-relative so it compares against the class table and lane globs, which
 * are declared repo-relative (`packages/server/src/**`). The PreToolUse hook `cd`s to the project root
 * before running, so `process.cwd()` is that root and an absolute `file_path` under it relativizes
 * cleanly. A path already relative, or absolute-but-outside the root (→ a leading `../`), is left as-is
 * (the latter simply won't match a repo glob — correctly ungated).
 */
export function repoRelativePath(path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

async function gateCheck(parsed: Parsed): Promise<number> {
  if (parsed.flags['stdin'] !== true) {
    throw new CliError(
      'usage: musterd gate check --stdin  — hook-driven: pipe the PreToolUse hook JSON in ' +
        '(`musterd init` wires the hook)',
      2,
    );
  }
  try {
    const raw = parseToolCall(await readStdin());
    if (!raw) return 0; // nothing to match on → allow
    // Normalize the target path to repo-relative BEFORE matching, so class + lane globs compare cleanly.
    const call: GateToolCall = raw.path ? { ...raw, path: repoRelativePath(raw.path) } : raw;
    const { http, team, identity, explicit } = resolveRead(parsed.flags);
    if (!explicit || !identity) return 0; // ambient/unbound folder — no seat to gate → allow
    const { enforcement } = await http.getEnforcement(team);
    const match = matchEnforcement(enforcement, call);
    if (!match) return 0; // undeclared call → allow, no daemon round-trip (the common case)
    const decision = await http.gateCheck(team, {
      kind: match.cls.kind,
      class: match.cls.class,
      fingerprint: match.fingerprint,
      posture: match.cls.posture,
      tool: call.tool,
      target: match.target,
    });
    if (decision.decision === 'deny') emitDeny(decision.reason);
    else if (decision.outcome === 'warned' && decision.reason) emitWarn(decision.reason);
  } catch {
    // Fail-open: a gate must never break the tool call it rides on (ADR 150 guard metric).
  }
  return 0;
}
