import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../client.js';
import { recordSessionEdit } from '../workingTree.js';
import {
  attest,
  parseEnvelopeSessionId,
  parseToolCall,
  repoRelativePath,
  workingTreeWarning,
} from './gate.js';

/**
 * Unit coverage for the gate hook's payload parse (ADR 150). The end-to-end adjudication is covered by
 * the server's gate-http test; here we pin the lenient extraction of a Claude Code PreToolUse payload —
 * the thing that decides what (if anything) the matcher sees, and that a malformed payload yields null
 * (→ the caller allows, fail-open).
 */
describe('parseToolCall (ADR 150 PreToolUse payload)', () => {
  it('extracts a Bash command', () => {
    const call = parseToolCall(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 320' } }),
    );
    expect(call).toEqual({ tool: 'Bash', command: 'gh pr merge 320' });
  });

  it('extracts an Edit/Write file path', () => {
    expect(
      parseToolCall(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } })),
    ).toEqual({ tool: 'Write', path: 'src/x.ts' });
  });

  it('extracts a NotebookEdit notebook path', () => {
    expect(
      parseToolCall(
        JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb' } }),
      ),
    ).toEqual({ tool: 'NotebookEdit', path: 'n.ipynb' });
  });

  it('a tool with neither path nor command yields a call that matches nothing', () => {
    expect(parseToolCall(JSON.stringify({ tool_name: 'Read', tool_input: {} }))).toEqual({
      tool: 'Read',
    });
  });

  it('null on malformed / non-object / missing tool_name (→ caller allows, fail-open)', () => {
    expect(parseToolCall('not json')).toBeNull();
    expect(parseToolCall('[]')).toBeNull();
    expect(parseToolCall('42')).toBeNull();
    expect(parseToolCall(JSON.stringify({ tool_input: { command: 'x' } }))).toBeNull();
    expect(parseToolCall('')).toBeNull();
  });
});

describe('repoRelativePath (ADR 150) — compare paths against repo-relative lane globs', () => {
  it('relativizes an absolute path under cwd', () => {
    const abs = join(process.cwd(), 'packages/server/src/x.ts');
    expect(repoRelativePath(abs)).toBe('packages/server/src/x.ts');
  });

  it('leaves an already-relative path untouched', () => {
    expect(repoRelativePath('src/tariff.ts')).toBe('src/tariff.ts');
  });

  it('leaves an absolute path OUTSIDE cwd as-is (a leading .. → correctly ungated)', () => {
    expect(repoRelativePath('/etc/passwd')).toBe('/etc/passwd');
  });
});

/**
 * ADR 163 — actor attestation. Two halves: the payload ENVELOPE parse (the `agent_id` that distinguishes
 * a subagent's call from its parent's — the fact the whole ADR rests on), and `attest`'s decision about
 * which calls earn a row. The emission is fire-and-forget, so these assert on what the client is ASKED
 * to record, never on a resolved promise.
 */
describe('parseToolCall — actor envelope (ADR 163)', () => {
  it("a parent seat's call carries no actor fields", () => {
    expect(
      parseToolCall(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'a.ts' } })),
    ).toEqual({ tool: 'Write', path: 'a.ts' });
  });

  it("a subagent's own call carries agent_id + agent_type from the envelope, not tool_input", () => {
    expect(
      parseToolCall(
        JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: 'a.ts' },
          agent_id: 'a940f12fd1c5d9c48',
          agent_type: 'Explore',
        }),
      ),
    ).toEqual({
      tool: 'Write',
      path: 'a.ts',
      actorId: 'a940f12fd1c5d9c48',
      actorType: 'Explore',
    });
  });

  it('a spawn call carries the requested type + model override, and NO agent_id', () => {
    const call = parseToolCall(
      JSON.stringify({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', model: 'haiku', prompt: 'go' },
      }),
    );
    expect(call).toEqual({ tool: 'Agent', spawnType: 'Explore', spawnModel: 'haiku' });
    // The join's whole problem, pinned: the spawn knows the model but not who it becomes.
    expect(call?.actorId).toBeUndefined();
  });
});

describe('attest (ADR 163) — which calls earn a row', () => {
  /** A stand-in for the one client method `attest` may reach for. */
  function spy(): { calls: unknown[]; http: HttpClient } {
    const calls: unknown[] = [];
    const http = {
      recordActor: (_team: string, body: unknown) => {
        calls.push(body);
        return Promise.resolve();
      },
    } as unknown as HttpClient;
    return { calls, http };
  }

  it("records a subagent's write", () => {
    const { calls, http } = spy();
    attest(http, 't', { tool: 'Write', path: 'a.ts', actorId: 'ag1', actorType: 'Explore' });
    expect(calls).toEqual([
      {
        kind: 'subagent-write',
        tool: 'Write',
        actorId: 'ag1',
        actorType: 'Explore',
        target: 'a.ts',
      },
    ]);
  });

  it("NEVER records a subagent's read — the read/write asymmetry", () => {
    const { calls, http } = spy();
    attest(http, 't', { tool: 'Read', path: 'a.ts', actorId: 'ag1', actorType: 'Explore' });
    attest(http, 't', { tool: 'Bash', command: 'grep -rn x src/', actorId: 'ag1' });
    expect(calls).toEqual([]);
  });

  it("NEVER records the parent seat's own write — no actorId, nothing to attribute", () => {
    const { calls, http } = spy();
    attest(http, 't', { tool: 'Write', path: 'a.ts' });
    expect(calls).toEqual([]);
  });

  it('records a spawn as the denominator, with the model override', () => {
    const { calls, http } = spy();
    attest(http, 't', { tool: 'Agent', spawnType: 'Explore', spawnModel: 'haiku' });
    expect(calls).toEqual([
      { kind: 'subagent-spawn', tool: 'Agent', spawnType: 'Explore', spawnModel: 'haiku' },
    ]);
  });

  it('an Agent call with neither type nor model records nothing', () => {
    const { calls, http } = spy();
    attest(http, 't', { tool: 'Agent' });
    expect(calls).toEqual([]);
  });

  it("a subagent's write-shaped Bash records the command as target", () => {
    const { calls, http } = spy();
    attest(http, 't', { tool: 'Bash', command: 'rm -rf build', actorId: 'ag1' });
    expect(calls).toEqual([
      { kind: 'subagent-write', tool: 'Bash', actorId: 'ag1', target: 'rm -rf build' },
    ]);
  });
});

/**
 * ADR 167 — the session-messaging observer. The load-bearing property is REDUCTION AT PARSE TIME: the
 * raw body and raw target session id exist only inside `parseToolCall`'s frame, so every assertion here
 * checks both what IS on the object (16-hex fingerprints, an extracted ULID) and what is NOT (the raw
 * values, anywhere).
 */
describe('parseToolCall + attest — session-message observation (ADR 167)', () => {
  const SEND = 'mcp__ccd_session_mgmt__send_message';

  function spy(): { calls: unknown[]; http: HttpClient } {
    const calls: unknown[] = [];
    const http = {
      recordActor: (_team: string, body: unknown) => {
        calls.push(body);
        return Promise.resolve();
      },
    } as unknown as HttpClient;
    return { calls, http };
  }

  it('reduces body and session id to sha256-16 at parse time — the raw values are never kept', () => {
    const body = 'secret payload with a token ghp_abc123';
    const session = '4ebb058f-9602-4d54-83d2-de786af80d88';
    const call = parseToolCall(
      JSON.stringify({ tool_name: SEND, tool_input: { message: body, session_id: session } }),
    );
    expect(call?.tool).toBe(SEND);
    expect(call?.bodyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(call?.sessionRef).toMatch(/^[0-9a-f]{16}$/);
    // Nothing on the object carries the raw values — the property the whole observer rests on.
    expect(JSON.stringify(call)).not.toContain('secret');
    expect(JSON.stringify(call)).not.toContain(session);
  });

  it('extracts a ULID from the body as nudgeRef; none present → no field', () => {
    const withUlid = parseToolCall(
      JSON.stringify({
        tool_name: SEND,
        tool_input: {
          message: 'musterd: stanley sent you a handoff (01KYJYPH5894Y327A1XSNX41TX) — check inbox',
          session_id: 's',
        },
      }),
    );
    expect(withUlid?.nudgeRef).toBe('01KYJYPH5894Y327A1XSNX41TX');
    const without = parseToolCall(
      JSON.stringify({
        tool_name: SEND,
        tool_input: { message: 'hey, look at lane.ts', session_id: 's' },
      }),
    );
    expect(without?.nudgeRef).toBeUndefined();
  });

  it('attest records kind session-message with fingerprints only', () => {
    const { calls, http } = spy();
    const call = parseToolCall(
      JSON.stringify({ tool_name: SEND, tool_input: { message: 'ping', session_id: 'abc' } }),
    );
    expect(call).not.toBeNull();
    if (call) attest(http, 't', call);
    expect(calls).toHaveLength(1);
    const rec = calls[0] as Record<string, string>;
    expect(rec['kind']).toBe('session-message');
    expect(rec['tool']).toBe(SEND);
    expect(rec['bodyFingerprint']).toMatch(/^[0-9a-f]{16}$/);
    expect(rec['sessionRef']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(rec)).not.toContain('ping');
    expect(JSON.stringify(rec)).not.toContain('abc');
  });

  it('an unrecognized input shape still earns a row — "a send happened" is itself the datum', () => {
    const { calls, http } = spy();
    attest(http, 't', { tool: SEND });
    expect(calls).toEqual([{ kind: 'session-message', tool: SEND }]);
  });

  it('list_sessions-style reads on the same server never reach attest with a session-message row', () => {
    const { calls, http } = spy();
    attest(http, 't', { tool: 'mcp__ccd_session_mgmt__list_sessions' });
    expect(calls).toEqual([]);
  });
});

describe('the working-tree check (ADR 239)', () => {
  const repo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-gate-wt-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    };
    git('init', '-q');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a-work.txt'), 'base\n');
    writeFileSync(join(dir, 'b-work.txt'), 'base\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    return dir;
  };

  /** The envelope carries `session_id` (measured, ADR 163) — the index is keyed on it. */
  it('reads the session id off the envelope, not tool_input', () => {
    expect(
      parseEnvelopeSessionId(JSON.stringify({ session_id: 'sess-9', tool_name: 'Bash' })),
    ).toBe('sess-9');
    expect(parseEnvelopeSessionId(JSON.stringify({ tool_input: { session_id: 'nope' } }))).toBe(
      undefined,
    );
    expect(parseEnvelopeSessionId('not json')).toBe(undefined);
  });

  /** The incident, end to end: A's file is modified and absent from B's index, so B is told. */
  it('names the file this session never wrote', () => {
    const dir = repo();
    const state = mkdtempSync(join(tmpdir(), 'musterd-gate-state-'));
    writeFileSync(join(dir, 'a-work.txt'), "A's in-progress lane work\n"); // session A
    writeFileSync(join(dir, 'b-work.txt'), "B's capture\n"); // session B
    recordSessionEdit(state, 'sess-B', 'b-work.txt');
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const warn = workingTreeWarning('git add -A', 'sess-B', state);
      expect(warn).toContain('a-work.txt');
      expect(warn).not.toContain('b-work.txt');
    } finally {
      process.chdir(cwd);
    }
  });

  it('is silent when every modified path is the session’s own', () => {
    const dir = repo();
    const state = mkdtempSync(join(tmpdir(), 'musterd-gate-state-'));
    writeFileSync(join(dir, 'b-work.txt'), 'mine\n');
    recordSessionEdit(state, 'sess-B', 'b-work.txt');
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      expect(workingTreeWarning('git add -A', 'sess-B', state)).toBe(undefined);
    } finally {
      process.chdir(cwd);
    }
  });

  /** The ADR's cost claim, with a falsifier: a non-stage-shaped command must not reach git at all.
   *  Asserted from outside a repo — `git status` there would throw, and the check returns undefined
   *  either way, so the observable difference is that these are cheap, not that they are quiet. */
  it('does not shell out for a command that stages nothing', () => {
    const state = mkdtempSync(join(tmpdir(), 'musterd-gate-state-'));
    for (const cmd of ['pnpm build', 'git status', 'git commit -m wip', 'git add src/one.ts']) {
      expect(workingTreeWarning(cmd, 'sess', state)).toBe(undefined);
    }
    expect(workingTreeWarning(undefined, 'sess', state)).toBe(undefined);
    expect(workingTreeWarning('git add -A', undefined, state)).toBe(undefined);
  });

  /** Decision 5 — nothing on this path may write to the working tree. */
  it('leaves the working tree exactly as it found it', () => {
    const dir = repo();
    const state = mkdtempSync(join(tmpdir(), 'musterd-gate-state-'));
    writeFileSync(join(dir, 'a-work.txt'), 'foreign\n');
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const before = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
      expect(workingTreeWarning('git add -A', 'sess-B', state)).toContain('a-work.txt');
      const after = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
      expect(after).toBe(before); // nothing staged, nothing stashed, nothing moved
    } finally {
      process.chdir(cwd);
    }
  });

  it('never warns outside a git repo', () => {
    const state = mkdtempSync(join(tmpdir(), 'musterd-gate-state-'));
    const notRepo = mkdtempSync(join(tmpdir(), 'musterd-gate-norepo-'));
    const cwd = process.cwd();
    try {
      process.chdir(notRepo);
      expect(workingTreeWarning('git add -A', 'sess', state)).toBe(undefined);
    } finally {
      process.chdir(cwd);
    }
  });
});
