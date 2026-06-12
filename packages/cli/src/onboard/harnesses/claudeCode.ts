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
