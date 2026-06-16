import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Harness } from '../harness.js';

const exec = promisify(execFile);

async function has(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8000 });
    return { ok: true, out: stdout };
    // reason: exec rejection is an untyped error-like with optional stdout/message.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    return { ok: false, out: String(err?.stdout ?? err?.message ?? '') };
  }
}

/**
 * Where the `claude` CLI commonly lives. `execFile` resolves against the *launching terminal's*
 * PATH only, so a venv/conda/non-login shell can hide an installed CLI — init then reports
 * "not installed" while the Claude Code extension runs fine (dogfood finding). Falling back to
 * these absolute paths (and using the resolved one for `configure`) makes detection PATH-robust.
 */
function claudeCandidates(): string[] {
  const home = homedir();
  return [
    join(home, '.npmglobal/bin/claude'),
    join(home, '.npm-global/bin/claude'),
    join(home, '.claude/local/claude'),
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

let claudeBinCache: string | null | undefined;
/** Resolve a runnable `claude`: PATH first, then known install locations. Cached per process. */
async function resolveClaudeBin(): Promise<string | null> {
  if (claudeBinCache !== undefined) return claudeBinCache;
  if ((await has('claude', ['--version'])).ok) return (claudeBinCache = 'claude');
  for (const c of claudeCandidates()) {
    if (existsSync(c) && (await has(c, ['--version'])).ok) return (claudeBinCache = c);
  }
  return (claudeBinCache = null);
}

/** Claude Code: configured through the official `claude mcp` CLI (no hand-editing JSON). */
export const claudeCode: Harness = {
  id: 'claude-code',
  label: 'Claude Code',
  surface: 'claude-code',

  async detect() {
    const bin = await resolveClaudeBin();
    if (!bin) {
      return {
        installed: false,
        configured: false,
        detail: 'claude CLI not found on PATH or common install locations',
      };
    }
    const ver = await has(bin, ['--version']);
    const got = await has(bin, ['mcp', 'get', 'musterd']);
    const where = bin === 'claude' ? '' : ` (${bin})`;
    return {
      installed: true,
      configured: got.ok,
      detail: `claude ${ver.out.trim().split(' ')[0] ?? ''}${where}`.trim(),
    };
  },

  async configure(entry) {
    // claude mcp add musterd -s local -e K=V ... -- <command> <args...>
    const bin = (await resolveClaudeBin()) ?? 'claude';
    const envArgs = Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const args = [
      'mcp',
      'add',
      'musterd',
      '-s',
      'local',
      ...envArgs,
      '--',
      entry.command,
      ...entry.args,
    ];
    // Replace any prior definition so re-running init is idempotent.
    await exec(bin, ['mcp', 'remove', 'musterd', '-s', 'local']).catch(() => undefined);
    await exec(bin, args, { timeout: 10000 });
    return {
      target: 'claude mcp (scope: local)',
      activation: activationHint(),
      scope: `wired into this folder only (${process.cwd()}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
    };
  },
};

/**
 * The MCP server is registered at Claude Code's project-local scope (keyed by this
 * folder). Both the terminal CLI and the Claude Code editor extension read it — they
 * just need this folder open. Lead with whichever path fits where init is running.
 */
function activationHint(): string {
  const inEditor = process.env['TERM_PROGRAM'] === 'vscode' || Boolean(process.env['VSCODE_PID']);
  const ext =
    'in the Claude Code extension, open this folder and start a new chat (reload the window if it was already open)';
  const term = 'in a terminal here, run `claude`';
  const lead = inEditor ? `${ext}; or ${term}` : `${term}; or ${ext}`;
  return `${lead} — then verify the musterd tools are present with /mcp inside the session`;
}
