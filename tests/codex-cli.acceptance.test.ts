import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BindingSchema, bindingSeat, makeEnvelope } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { resolveCodexBin } from '../packages/cli/src/codexBin.js';
import { parseCodexThreadLine } from '../packages/cli/src/host/backends/codex.js';

const enabled =
  process.env['MUSTERD_REAL_CODEX'] === '1' && process.env['MUSTERD_REAL_CODEX_CONFIRM'] === '1';
const realIt = enabled ? it : it.skip;
const repo = process.cwd();

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  threadId?: string;
}

/** Keep the operator's Codex account/config, but make the fixture binding its only musterd identity. */
export function codexAcceptanceEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  return env;
}

/** Diagnostics are useful on an owner-run failure, but credentials must never enter a test assertion. */
export function redactCodexDiagnostic(value: string): string {
  return value
    .replace(/\bms(?:key|gr|cr)_[A-Za-z0-9_-]+\b/g, '[redacted musterd credential]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]');
}

function runCodex(bin: string, args: string[], cwd: string, timeoutMs = 75_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: codexAcceptanceEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let threadId: string | undefined;
    let stdoutRemainder = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      const lines = (stdoutRemainder + text).split('\n');
      stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) threadId ??= parseCodexThreadLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Codex real acceptance timed out'));
      threadId ??= parseCodexThreadLine(stdoutRemainder);
      resolve({
        code,
        stdout: redactCodexDiagnostic(stdout),
        stderr: redactCodexDiagnostic(stderr),
        ...(threadId ? { threadId } : {}),
      });
    });
  });
}

async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  seat?: string,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(seat ? { 'x-musterd-seat': seat } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return text ? (JSON.parse(text) as Record<string, any>) : {};
}

let server: RunningServer | undefined;
let workspace: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe('Codex CLI real acceptance (owner-gated)', () => {
  it('keeps the paid acceptance gate closed unless both explicit variables are set', () => {
    expect(enabled).toBe(
      process.env['MUSTERD_REAL_CODEX'] === '1' &&
        process.env['MUSTERD_REAL_CODEX_CONFIRM'] === '1',
    );
  });

  it('uses only fixture-safe Codex environment values and redacts credentials from failures', () => {
    const env = codexAcceptanceEnv({
      HOME: '/home/nick',
      PATH: '/bin',
      MUSTERD_AGENT_KEY: 'mskey_should-not-pass',
      MUSTERD_GRANT: 'msgr_should-not-pass',
      MUSTERD_BINDING: '/another/worktree/.musterd/binding.json',
    });
    expect(env).toEqual({ HOME: '/home/nick', PATH: '/bin' });
    expect(redactCodexDiagnostic('mskey_secret Bearer secret msgr_secret mscr_secret')).toBe(
      '[redacted musterd credential] Bearer [redacted] [redacted musterd credential] [redacted musterd credential]',
    );
  });

  realIt(
    'joins through project MCP, drains a directed inbox, and resumes the exact thread',
    async () => {
      const bin = await resolveCodexBin();
      expect(bin, 'Codex CLI was not found').toBeTruthy();
      expect(existsSync(join(repo, 'packages', 'mcp', 'dist', 'index.js'))).toBe(true);

      server = createServer({ db: openDb(':memory:'), port: 0 });
      const { port } = await server.listen();
      const base = `http://127.0.0.1:${port}`;
      const team = await api(base, 'POST', '/teams', {
        slug: 'codex-real',
        creator: { name: 'nick', kind: 'human', role: 'lead' },
      });
      const admin = team.human_credential as string;
      await api(base, 'POST', '/teams/codex-real/members', { name: 'Ada', kind: 'agent' }, admin);
      const grant = await api(
        base,
        'POST',
        '/teams/codex-real/grants',
        { scope: 'seat', target: 'Ada', lifetime: 'standing' },
        admin,
      );

      workspace = mkdtempSync(join(tmpdir(), 'musterd-codex-real-'));
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      mkdirSync(join(workspace, '.musterd'), { recursive: true });
      writeFileSync(
        join(workspace, '.musterd', 'binding.json'),
        JSON.stringify(
          {
            // Strict v2 identity (ADR 281): `version` required, no `surface`, unknown keys reject.
            version: 2,
            server: base,
            team: 'codex-real',
            agent_key: team.agent_key,
            grant: grant.token,
            claim: { mode: 'seat', name: 'Ada' },
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
      mkdirSync(join(workspace, '.codex'), { recursive: true });
      writeFileSync(
        join(workspace, '.codex', 'config.toml'),
        // The launch-Surface marker (ADR 286) mirrors what `musterd harness configure` writes;
        // without it the adapter refuses Presence attachment at boot.
        `[mcp_servers.musterd]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(repo, 'packages', 'mcp', 'dist', 'index.js'))}]\n\n[mcp_servers.musterd.env]\nMUSTERD_LAUNCH_SURFACE = "codex"\n`,
        { mode: 0o600 },
      );
      await api(
        base,
        'POST',
        '/teams/codex-real/messages',
        {
          envelope: makeEnvelope({
            id: 'codex-real-directed',
            team: 'codex-real',
            from: 'nick',
            to: { kind: 'member', name: 'Ada' },
            act: 'message',
            body: 'real Codex inbox fixture',
          }),
        },
        admin,
      );

      const first = await runCodex(
        bin!,
        [
          'exec',
          '--json',
          '-C',
          workspace,
          'Use the musterd MCP tools now. Call team_join with {"as":"Ada"}, then call team_inbox_check. Do not edit files. Finish after those two calls.',
        ],
        workspace,
      );
      expect(first.code, first.stderr).toBe(0);
      expect(first.threadId, first.stdout).toBeTruthy();
      // v0.3 identity persists the seat inside `claim`, not a scalar `member` (ADR 075 / ADR 281).
      // Parsing through the strict schema proves the adapter's write-back is still readable.
      const binding = BindingSchema.parse(
        JSON.parse(readFileSync(join(workspace, '.musterd', 'binding.json'), 'utf8')),
      );
      expect(bindingSeat(binding)).toBe('Ada');
      const unread = await api(
        base,
        'GET',
        '/teams/codex-real/inbox?unread=1',
        undefined,
        team.agent_key as string,
        'Ada',
      );
      expect(unread.messages).toEqual([]);

      const resumed = await runCodex(
        bin!,
        [
          'exec',
          'resume',
          '--json',
          first.threadId!,
          'Use team_inbox_check once. Do not edit files. Finish after that tool call.',
        ],
        workspace,
      );
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(resumed.threadId).toBe(first.threadId);
    },
    180_000,
  );
});
