import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Harness } from '../harness.js';

const exec = promisify(execFile);

async function has(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8000 });
    return { ok: true, out: stdout };
  } catch (err: any) {
    return { ok: false, out: String(err?.stdout ?? err?.message ?? '') };
  }
}

/** Claude Code: configured through the official `claude mcp` CLI (no hand-editing JSON). */
export const claudeCode: Harness = {
  id: 'claude-code',
  label: 'Claude Code',
  surface: 'claude-code',

  async detect() {
    const installed = await has('claude', ['--version']);
    if (!installed.ok) {
      return { installed: false, configured: false, detail: 'claude CLI not found on PATH' };
    }
    const got = await has('claude', ['mcp', 'get', 'musterd']);
    return {
      installed: true,
      configured: got.ok,
      detail: `claude ${installed.out.trim().split(' ')[0] ?? ''}`.trim(),
    };
  },

  async configure(entry) {
    // claude mcp add musterd -s local -e K=V ... -- <command> <args...>
    const envArgs = Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const args = ['mcp', 'add', 'musterd', '-s', 'local', ...envArgs, '--', entry.command, ...entry.args];
    // Replace any prior definition so re-running init is idempotent.
    await exec('claude', ['mcp', 'remove', 'musterd', '-s', 'local']).catch(() => undefined);
    await exec('claude', args, { timeout: 10000 });
    return {
      target: 'claude mcp (scope: local)',
      activation: 'start a Claude Code session in this directory (run `claude`) — the agent joins on launch',
    };
  },
};
