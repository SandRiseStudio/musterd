/**
 * The wall's canary (ADR 442, plan Task 8) — the one test that says the wall is up on `main`.
 *
 * Every other ADR 442 test pins one piece in-process: `sessionReachReason` in gate.test.ts, the
 * subagent ledger, binding-only identity in helpers.identity.test.ts, the retired guidance units.
 * This one drives the BUILT binary the way a harness does — `musterd gate check --stdin` as a child
 * process with the PreToolUse hook JSON on stdin, from a folder bound to a seat — against an
 * in-process daemon, and checks the four things the ADR promises together:
 *
 *   1. a seat cannot reach a foreign session, and the refusal is a deny the harness understands;
 *   2. the refusal is audited on the daemon as `gate.session_denied` (§Decision 4);
 *   3. an unbound folder acts as nobody — `inbox` exits 4 even though the vault holds nick (§6);
 *   4. the deny is decided locally: a dead daemon still refuses (§Decision 2).
 *
 * Plus the one allow the wall must keep: `SendMessage` to a subagent this session spawned.
 *
 * Runs `packages/cli/dist/bin.js`, so it needs a build first (`pnpm -r build`); CI's `gates` job
 * builds before it tests. A missing dist fails loudly rather than skipping — a canary that can be
 * skipped is not a canary.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.js';
import { teamCommand } from './commands/team.js';
import { loadConfig, saveBinding } from './config.js';
import { claimAgentHttp } from './test-auth.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');

let server: RunningServer;
let serverUrl: string;
let configDir: string;
let nickConfig: string;
let nickDir: string;
let seatDir: string;

async function run(fn: (p: ReturnType<typeof parseArgs>) => Promise<number>, argv: string[]) {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    return await fn(parseArgs(argv));
  } finally {
    spy.mockRestore();
  }
}

interface Child {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI as a harness would: a child process, cwd = the folder, JSON on stdin. */
function musterd(
  cwd: string,
  argv: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<Child> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      cwd,
      env: {
        ...process.env,
        MUSTERD_SERVER: serverUrl,
        MUSTERD_CONFIG: nickConfig,
        CLAUDECODE: '1',
        ...opts.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(opts.stdin ?? '');
  });
}

function hook(sessionId: string, tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: input,
  });
}

function decision(child: Child): string | undefined {
  if (!child.stdout.trim()) return undefined;
  const out = JSON.parse(child.stdout) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  return out.hookSpecificOutput?.permissionDecision;
}

function sessionDeniedRows(): number {
  return server.db
    .prepare<
      [],
      { n: number }
    >(`SELECT count(*) AS n FROM audit WHERE action = 'gate.session_denied' AND result = 'deny'`)
    .get()!.n;
}

async function eventually(check: () => void, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > until) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

beforeEach(async () => {
  if (!existsSync(BIN)) {
    throw new Error(
      `the wall's canary needs the built CLI at ${BIN} — run \`pnpm -r build\` first`,
    );
  }
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  serverUrl = `http://127.0.0.1:${port}`;
  process.env['MUSTERD_SERVER'] = serverUrl;
  configDir = mkdtempSync(join(tmpdir(), 'musterd-canary-'));
  nickConfig = join(configDir, 'nick.json');
  process.env['MUSTERD_CONFIG'] = nickConfig;
  // `team create` auto-binds its cwd as nick (ADR 036); that folder is nick's Workspace here.
  nickDir = mkdtempSync(join(tmpdir(), 'musterd-canary-nick-'));
  vi.spyOn(process, 'cwd').mockReturnValue(nickDir);
  await run(teamCommand, ['create', 'dawn', '--member', 'nick']);
  await run(teamCommand, ['add', 'dolly', '--kind', 'agent']);
  // dolly's own Workspace: a folder bound to the seat with its routine authority.
  const cfg = loadConfig();
  const auth = await claimAgentHttp(
    serverUrl,
    'dawn',
    cfg.agentKeys['dawn']!,
    cfg.identities['dawn']!.key,
    'dolly',
  );
  seatDir = mkdtempSync(join(tmpdir(), 'musterd-canary-dolly-'));
  saveBinding(seatDir, {
    version: 2,
    server: serverUrl,
    team: 'dawn',
    claim: { mode: 'seat', name: 'dolly' },
    seat_credential: auth.key,
    session_lease: auth.sessionLease,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  for (const d of [configDir, nickDir, seatDir]) rmSync(d, { recursive: true, force: true });
  delete process.env['MUSTERD_SERVER'];
  delete process.env['MUSTERD_CONFIG'];
});

describe('the wall canary (ADR 442)', () => {
  it('a seat cannot reach a non-seat session, and the refusal is audited', async () => {
    const out = await musterd(seatDir, ['gate', 'check', '--stdin'], {
      stdin: hook('s1', 'mcp__ccd_session_mgmt__send_message', {
        session_id: 'foreign',
        message: 'hi',
      }),
    });
    expect(out.code).toBe(0); // the hook protocol: the verdict is the JSON, not the exit code
    expect(decision(out)).toBe('deny');
    expect(out.stdout).toMatch(/may not reach other sessions \(ADR 442\)/);
    // §Decision 4: the daemon holds the row — tool + harness, no body, no target, no session id.
    await eventually(() => expect(sessionDeniedRows()).toBe(1));
    const row = server.db
      .prepare<
        [],
        { target: string | null; detail: string | null }
      >(`SELECT target, detail FROM audit WHERE action = 'gate.session_denied'`)
      .get()!;
    expect(row.target).toBeNull();
    expect(row.detail ?? '').not.toContain('foreign');
    expect(row.detail ?? '').not.toContain('s1');
  });

  it('ListAgents is refused too, and a dead daemon does not open the wall', async () => {
    const out = await musterd(seatDir, ['gate', 'check', '--stdin'], {
      stdin: hook('s1', 'ListAgents', {}),
      env: { MUSTERD_SERVER: 'http://127.0.0.1:1' }, // nothing listens here
    });
    expect(decision(out)).toBe('deny');
    expect(sessionDeniedRows()).toBe(0); // only the audit is lost
  });

  it('SendMessage still reaches a subagent this session spawned', async () => {
    const recorded = await musterd(seatDir, ['gate', 'record-subagent'], {
      stdin: JSON.stringify({
        session_id: 's1',
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: 'Agent started. agentId: a1b2c3',
      }),
    });
    expect(recorded.code).toBe(0);
    const own = await musterd(seatDir, ['gate', 'check', '--stdin'], {
      stdin: hook('s1', 'SendMessage', { to: 'a1b2c3', message: 'status?' }),
    });
    expect(decision(own)).toBeUndefined();
    const other = await musterd(seatDir, ['gate', 'check', '--stdin'], {
      stdin: hook('s1', 'SendMessage', { to: 'someone-else', message: 'status?' }),
    });
    expect(decision(other)).toBe('deny');
  });

  it('an unbound folder reads nobody’s inbox, even with nick in the vault', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'musterd-canary-unbound-'));
    try {
      const out = await musterd(elsewhere, ['inbox']);
      expect(out.code).toBe(4);
      expect(out.stderr).toMatch(/no identity in this folder/);
      // And the gate has no jurisdiction there: no seat, nothing to wall off, nothing audited.
      const gate = await musterd(elsewhere, ['gate', 'check', '--stdin'], {
        stdin: hook('s9', 'ListAgents', {}),
      });
      expect(decision(gate)).toBeUndefined();
      expect(sessionDeniedRows()).toBe(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
