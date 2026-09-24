import { describe, expect, it } from 'vitest';
import { attendedHarnessProcess, type HarnessProcess } from './attendedProcess.js';

const proc = (over: Partial<HarnessProcess>): HarnessProcess => ({
  pid: 100,
  comm: 'claude',
  args: 'claude',
  cwd: '/ws/dolly',
  ...over,
});

describe('attendedHarnessProcess (ADR 444 host backstop)', () => {
  it('finds an interactive claude session whose cwd is the workspace', () => {
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', () => [proc({})])).toEqual({
      pid: 100,
    });
  });

  it('counts a session started in a subdirectory of the workspace', () => {
    const list = () => [proc({ cwd: '/ws/dolly/packages/cli' })];
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', list)).toEqual({ pid: 100 });
  });

  it('ignores headless runs — a wake child is spawned with -p', () => {
    const list = () => [
      proc({ pid: 1, args: 'claude -p musterd wake --session-id abc' }),
      proc({ pid: 2, args: 'claude --resume abc --print hi' }),
    ];
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', list)).toBeNull();
  });

  it('ignores sessions in other workspaces, including a sibling sharing a prefix', () => {
    const list = () => [proc({ cwd: '/ws/izzo' }), proc({ cwd: '/ws/dolly-old' })];
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', list)).toBeNull();
  });

  it('ignores a process whose cwd could not be read', () => {
    const list = () => [proc({ cwd: undefined })];
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', list)).toBeNull();
  });

  it('cannot tell (undefined) when the process table is unreadable', () => {
    expect(attendedHarnessProcess('/ws/dolly', 'claude-code', () => undefined)).toBeUndefined();
  });

  it('cannot tell (undefined) for a harness it has no process signature for', () => {
    expect(attendedHarnessProcess('/ws/dolly', 'codex', () => [proc({})])).toBeUndefined();
  });
});
