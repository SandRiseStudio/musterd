import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import {
  CCD_SEND_MESSAGE_TOOL,
  extractUlid,
  type GateToolCall,
  isWriteShaped,
  matchEnforcement,
  textFingerprint,
} from '@musterd/protocol';
import type { Parsed } from '../args.js';
import type { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import {
  foreignModifiedPaths,
  foreignPathWarning,
  isStageShaped,
  readSessionEdits,
  recordSessionEdit,
} from '../workingTree.js';
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
    // ADR 163 — the payload ENVELOPE, not the tool input. `agent_id`/`agent_type` are present only on a
    // subagent's own tool calls and absent on the parent seat's; measured on Claude Code 2.1.220. On a
    // spawn call (`tool_name: Agent`) the requested type + `model:` override live in tool_input instead,
    // and carry no agent_id — the two halves share no key, which is why nothing joins them here.
    const actorId = typeof o['agent_id'] === 'string' ? o['agent_id'] : undefined;
    const actorType = typeof o['agent_type'] === 'string' ? o['agent_type'] : undefined;
    const spawnType =
      typeof input['subagent_type'] === 'string' ? input['subagent_type'] : undefined;
    const spawnModel = typeof input['model'] === 'string' ? input['model'] : undefined;
    // ADR 167 — the harness session-messaging send. The raw body and raw target session id are reduced
    // to sha256-16 HERE, inside this frame, and never assigned onto the returned object: what the rest
    // of the pipeline never holds, it cannot leak (the body is another agent's incoming context, ADR
    // 128). Lenient like everything else — a shape change in the tool input degrades to a
    // fingerprint-less attestation, never a failure.
    const isSessionMsg = tool === CCD_SEND_MESSAGE_TOOL;
    const body =
      isSessionMsg && typeof input['message'] === 'string' ? input['message'] : undefined;
    const targetSession =
      isSessionMsg && typeof input['session_id'] === 'string' ? input['session_id'] : undefined;
    const nudgeRef = body ? extractUlid(body) : undefined;
    return {
      tool,
      ...(path ? { path } : {}),
      ...(command ? { command } : {}),
      ...(actorId ? { actorId } : {}),
      ...(actorType ? { actorType } : {}),
      ...(spawnType ? { spawnType } : {}),
      ...(spawnModel ? { spawnModel } : {}),
      ...(body ? { bodyFingerprint: textFingerprint(body) } : {}),
      ...(targetSession ? { sessionRef: textFingerprint(targetSession) } : {}),
      ...(nudgeRef ? { nudgeRef } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The harness session id off the payload **envelope** (not `tool_input` — that slot belongs to the
 * ADR 167 send target). Measured present on every PreToolUse payload in ADR 163's table, alongside
 * `transcript_path` and `cwd`. Used only to key the ADR 239 per-session edit index, which never
 * leaves the machine — the id is deliberately not returned on `GateToolCall`, so nothing that goes
 * over the wire can pick it up.
 */
export function parseEnvelopeSessionId(raw: string): string | undefined {
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== 'object' || json === null) return undefined;
    const id = (json as Record<string, unknown>)['session_id'];
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The workspace's musterd state dir. The PreToolUse hook `cd`s to the project root before running
 *  (see {@link repoRelativePath}), and `musterd init` gitignores `.musterd/`. */
function stateDir(): string {
  return join(process.cwd(), '.musterd');
}

/**
 * ADR 239 — the working-tree check. Returns the advisory text when a stage-shaped command would
 * sweep in tracked files this session never wrote, and `undefined` otherwise (the overwhelmingly
 * common case, which costs one regex and no subprocess).
 *
 * `git status --porcelain` is the only git command on this path and it is read-only: decision 5
 * forbids touching another session's uncommitted work, for which there is no reflog.
 */
export function workingTreeWarning(
  command: string | undefined,
  sessionId: string | undefined,
  dir: string,
): string | undefined {
  if (!command || !sessionId || !isStageShaped(command)) return undefined;
  let porcelain: string;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined; // not a repo, git missing, or slow — never warn on a guess
  }
  const foreign = foreignModifiedPaths(porcelain, readSessionEdits(dir, sessionId));
  return foreign.length > 0 ? foreignPathWarning(foreign, command) : undefined;
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

/**
 * Decide whether this call deserves an actor row, and fire it off (ADR 163, increment 1; ADR 167 adds
 * the third shape). Three shapes qualify and nothing else:
 *
 * - a **spawn** (`tool_name: Agent`) — the denominator: how much fan-out is happening at all;
 * - a **write-shaped call carrying `actorId`** — a subagent wrote under its parent seat's identity;
 * - a **harness session-message send** (ADR 167) — a seat used the identityless side channel.
 *
 * Reads never qualify, which is the point: nick's rule blesses read-only fan-out, and an `Explore`
 * sweep's hundreds of reads would swamp the ledger for nothing. Returns immediately — the promise is
 * intentionally floated, and `recordActor` swallows its own errors.
 */
export function attest(http: HttpClient, team: string, call: GateToolCall): void {
  // ADR 167 — a seat used the harness's session-to-session send. Observation only, fingerprints only
  // (already reduced at parse time); fires even when the input shape was unrecognized, because "a send
  // happened" is itself the datum the side-channel ledger exists for.
  if (call.tool === CCD_SEND_MESSAGE_TOOL) {
    void http.recordActor(team, {
      kind: 'session-message',
      tool: call.tool,
      ...(call.bodyFingerprint ? { bodyFingerprint: call.bodyFingerprint } : {}),
      ...(call.sessionRef ? { sessionRef: call.sessionRef } : {}),
      ...(call.nudgeRef ? { nudgeRef: call.nudgeRef } : {}),
    });
    return;
  }
  if (call.tool === 'Agent') {
    if (call.spawnType === undefined && call.spawnModel === undefined) return;
    void http.recordActor(team, {
      kind: 'subagent-spawn',
      tool: call.tool,
      ...(call.spawnType ? { spawnType: call.spawnType } : {}),
      ...(call.spawnModel ? { spawnModel: call.spawnModel } : {}),
    });
    return;
  }
  if (call.actorId === undefined || !isWriteShaped(call)) return;
  void http.recordActor(team, {
    kind: 'subagent-write',
    tool: call.tool,
    actorId: call.actorId,
    ...(call.actorType ? { actorType: call.actorType } : {}),
    ...((call.path ?? call.command) ? { target: call.path ?? call.command } : {}),
  });
}

async function gateCheck(parsed: Parsed): Promise<number> {
  if (parsed.flags['stdin'] !== true) {
    throw new CliError(
      'usage: musterd gate check --stdin  — hook-driven: pipe the PreToolUse hook JSON in ' +
        '(`musterd init` wires the hook)',
      2,
    );
  }
  let wtWarn: string | undefined;
  // The hook protocol reads ONE control object off stdout, so the two advisories share a slot: an
  // enforcement decision always wins it (a deny must never be swallowed), and the ADR 239 warning is
  // flushed afterwards only if nothing was emitted. Tracked locally — this process handles one call.
  let emitted = false;
  const decide = async (): Promise<void> => {
    const stdin = await readStdin();
    const raw = parseToolCall(stdin);
    if (!raw) return; // nothing to match on → allow
    // Normalize the target path to repo-relative BEFORE matching, so class + lane globs compare cleanly.
    const call: GateToolCall = raw.path ? { ...raw, path: repoRelativePath(raw.path) } : raw;
    // ADR 239 — both halves of the working-tree check, before anything that can throw or round-trip.
    // Purely local: the index is a file in this workspace's `.musterd/`, and nothing here is sent.
    const sessionId = parseEnvelopeSessionId(stdin);
    if (sessionId) {
      if (call.path && isWriteShaped(call)) recordSessionEdit(stateDir(), sessionId, call.path);
      wtWarn = workingTreeWarning(call.command, sessionId, stateDir());
    }
    const { http, team, identity, explicit } = resolveRead(parsed.flags);
    if (!explicit || !identity) return; // ambient/unbound folder — no seat to gate → allow
    // ADR 163 — actor attestation, BEFORE the class table and independent of it. Deliberately not
    // awaited: nothing downstream reads the result, and an observer on the critical path would be the
    // latency tax the ADR's guard metric forbids. Fires on undeclared calls by design (ADR 150 §Gate B
    // as amended) — it cannot change whether the call proceeds, so it is not mediation.
    attest(http, team, call);
    const { enforcement } = await http.getEnforcement(team);
    const match = matchEnforcement(enforcement, call);
    if (!match) return; // undeclared call → allow, no daemon round-trip (the common case)
    const decision = await http.gateCheck(team, {
      kind: match.cls.kind,
      class: match.cls.class,
      fingerprint: match.fingerprint,
      posture: match.cls.posture,
      tool: call.tool,
      target: match.target,
    });
    if (decision.decision === 'deny') {
      emitDeny(decision.reason);
      emitted = true;
    } else if (decision.outcome === 'warned' && decision.reason) {
      emitWarn(decision.reason);
      emitted = true;
    }
  };
  try {
    await decide();
  } catch {
    // Fail-open: a gate must never break the tool call it rides on (ADR 150 guard metric).
  }
  // The ADR 239 advisory survives a failure above on purpose: an unreachable daemon is exactly when a
  // second session in the folder is least likely to be noticed any other way.
  if (wtWarn && !emitted) emitWarn(wtWarn);
  return 0;
}
