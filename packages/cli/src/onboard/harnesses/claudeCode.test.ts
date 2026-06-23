import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerEntry } from '../mcpEntry.js';

// Hermetic doubles for the two host probes claudeCode makes, so coverage doesn't depend on
// whether a real `claude` CLI is installed on the machine running the suite.
const m = vi.hoisted(() => ({ execFile: vi.fn(), existsSync: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: m.execFile }));
vi.mock('node:fs', () => ({ existsSync: m.existsSync }));

/** promisify(execFile) calls execFile(cmd, args, [opts], cb); drive cb from a per-test decision fn. */
function onExec(decide: (cmd: string, args: string[]) => { stdout?: string } | Error) {
  m.execFile.mockImplementation((...all: unknown[]) => {
    const cb = all[all.length - 1] as (e: Error | null, r?: { stdout: string }) => void;
    const cmd = all[0] as string;
    const args = all[1] as string[];
    const out = decide(cmd, args);
    if (out instanceof Error) cb(out);
    else cb(null, { stdout: out.stdout ?? '' });
  });
}

const entry: McpServerEntry = {
  command: 'node',
  args: ['/abs/index.js'],
  env: { MUSTERD_TEAM: 'dawn', MUSTERD_MEMBER: 'Ada' },
};
const binding = {
  server: 'http://localhost:4849',
  team: 'dawn',
  member: 'Ada',
  token: 'mskd_x',
  surface: 'claude-code' as const,
};

let savedTerm: string | undefined;
let savedVscode: string | undefined;

beforeEach(() => {
  vi.resetModules(); // claudeBinCache is module-level; a fresh import per test resets it
  m.execFile.mockReset();
  m.existsSync.mockReset();
  m.existsSync.mockReturnValue(false);
  savedTerm = process.env['TERM_PROGRAM'];
  savedVscode = process.env['VSCODE_PID'];
  delete process.env['TERM_PROGRAM'];
  delete process.env['VSCODE_PID'];
});

afterEach(() => {
  if (savedTerm === undefined) delete process.env['TERM_PROGRAM'];
  else process.env['TERM_PROGRAM'] = savedTerm;
  if (savedVscode === undefined) delete process.env['VSCODE_PID'];
  else process.env['VSCODE_PID'] = savedVscode;
});

async function load() {
  return (await import('./claudeCode.js')).claudeCode;
}

describe('claudeCode.detect', () => {
  it('reports not-installed when claude is nowhere on PATH or known paths', async () => {
    onExec(() => new Error('ENOENT'));
    const d = await (await load()).detect();
    expect(d).toMatchObject({ installed: false, configured: false });
    expect(d.detail).toContain('not found');
  });

  it('detects a PATH claude and reports it configured when `mcp get` succeeds', async () => {
    onExec((cmd, args) => {
      if (args[0] === '--version') return { stdout: '1.2.3 (Claude Code)' };
      if (args[0] === 'mcp' && args[1] === 'get') return { stdout: 'musterd: ...' };
      return {};
    });
    const d = await (await load()).detect();
    expect(d.installed).toBe(true);
    expect(d.configured).toBe(true);
    expect(d.detail).toContain('claude 1.2.3');
  });

  it('detects PATH claude but unconfigured when `mcp get` fails', async () => {
    onExec((cmd, args) => {
      if (args[0] === '--version') return { stdout: '1.2.3' };
      return new Error('No MCP server "musterd"');
    });
    const d = await (await load()).detect();
    expect(d.installed).toBe(true);
    expect(d.configured).toBe(false);
  });

  it('falls back to a known install path when PATH lookup fails', async () => {
    m.existsSync.mockImplementation((p: unknown) => String(p).endsWith('/.local/bin/claude'));
    onExec((cmd, args) => {
      if (cmd === 'claude') return new Error('not on PATH'); // PATH probe misses
      if (args[0] === '--version') return { stdout: '9.9' };
      return new Error('not configured');
    });
    const d = await (await load()).detect();
    expect(d.installed).toBe(true);
    expect(d.detail).toMatch(/\(.*\.local\/bin\/claude\)/);
  });
});

describe('claudeCode.configure', () => {
  it('removes any prior server then adds musterd at local scope, with the editor activation hint', async () => {
    process.env['TERM_PROGRAM'] = 'vscode';
    onExec(() => ({ stdout: '' })); // every exec (version probe, remove, add) succeeds
    const r = await (await load()).configure(entry, binding);
    expect(r.target).toContain('claude mcp');
    expect(r.scope).toContain('this folder only');
    expect(r.activation.startsWith('in the Claude Code extension')).toBe(true);

    // The add invocation carries -s local, the -e env pairs, and the runnable command.
    const addCall = m.execFile.mock.calls.find((c) => {
      const a = c[1] as string[];
      return a[0] === 'mcp' && a[1] === 'add';
    });
    expect(addCall).toBeTruthy();
    const args = addCall![1] as string[];
    expect(args).toEqual(expect.arrayContaining(['-s', 'local', '-e', 'MUSTERD_TEAM=dawn']));
    expect(args.slice(-2)).toEqual(['node', '/abs/index.js']);
  });

  it('leads with the terminal activation hint outside an editor', async () => {
    onExec(() => ({ stdout: '' }));
    const r = await (await load()).configure(entry, binding);
    expect(r.activation.startsWith('in a terminal here')).toBe(true);
  });
});
