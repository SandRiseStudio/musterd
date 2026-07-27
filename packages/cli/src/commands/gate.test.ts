import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../client.js';
import { attest, parseToolCall, repoRelativePath } from './gate.js';

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
