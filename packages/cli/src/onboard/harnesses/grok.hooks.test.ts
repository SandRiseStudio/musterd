import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntry } from '../mcpEntry.js';
import {
  GATE_MARKER,
  GROK_INTERRUPT_PRE_WRAP,
  GROK_INTERRUPT_STOP_SCRIPT,
  INTERRUPT_MARKER,
  STOP_MARKER,
  grok,
  inspectGrokHookDrift,
} from './grok.js';

const binding = {
  server: 'http://localhost:4849',
  team: 'dawn',
  agent_key: 'mskey_secret',
  surface: 'grok' as const,
  claim: { mode: 'seat' as const, name: 'Ada' },
};

type HookFile = {
  hooks: Record<
    string,
    { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]
  >;
};

let cwd: string;
let origCwd: string;
const hooksPath = () => join(cwd, '.grok', 'hooks', 'musterd.json');

function readHooks(): HookFile {
  return JSON.parse(readFileSync(hooksPath(), 'utf8')) as HookFile;
}

function commandsOn(event: string): string[] {
  return (readHooks().hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
}

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-grok-hooks-'));
  process.chdir(cwd);
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe('grok interrupt injection (ADR 370)', () => {
  it('wraps interrupt-check as PreToolUse additionalContext, not discarded PostToolUse stdout', async () => {
    await grok.configure(buildEntry(binding), binding);
    expect(existsSync(hooksPath())).toBe(true);

    const pre = readHooks().hooks['PreToolUse'] ?? [];
    const interrupt = pre.find((g) => g.hooks.some((h) => h.command.includes(INTERRUPT_MARKER)));
    expect(interrupt).toBeDefined();
    expect(interrupt?.matcher).toBeUndefined();
    const cmd = interrupt!.hooks[0]!.command;
    expect(cmd).toContain('inbox --interrupt-check');
    expect(cmd).toContain('additionalContext');
    expect(cmd).toContain('PreToolUse');
    expect(cmd).not.toContain('interrupt-check >/dev/null');

    const gate = pre.find((g) => g.hooks.some((h) => h.command.includes(GATE_MARKER)));
    expect(gate).toBeDefined();
    expect(gate?.matcher).toContain('run_terminal_command');

    expect(commandsOn('PostToolUse').some((c) => c.includes(INTERRUPT_MARKER))).toBe(false);
  });

  it('installs a Stop hook that blocks end_turn once with the interrupt line', async () => {
    await grok.configure(buildEntry(binding), binding);
    const stop = readHooks().hooks['Stop'] ?? [];
    expect(stop).toHaveLength(1);
    const cmd = stop[0]!.hooks[0]!.command;
    expect(cmd).toContain(STOP_MARKER);
    expect(cmd).toContain('--interrupt-check');
    expect(cmd).toContain('end_turn');
    expect(cmd).toContain('stopHookActive');
    expect(cmd).toContain('decision:"block"');
    expect(cmd).not.toContain('interrupt-check >/dev/null');
    expect(stop[0]!.hooks[0]!.timeout).toBe(10);
  });

  it('reports drift when the PreToolUse interrupt or Stop hook is missing', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readHooks();
    file.hooks['PreToolUse'] = (file.hooks['PreToolUse'] ?? []).filter(
      (g) => !g.hooks.some((h) => h.command.includes(INTERRUPT_MARKER)),
    );
    delete file.hooks['Stop'];
    writeFileSync(hooksPath(), JSON.stringify(file));
    const drift = inspectGrokHookDrift(cwd);
    expect(drift.some((d) => d.includes('PreToolUse interrupt'))).toBe(true);
    expect(drift.some((d) => d.includes('Stop'))).toBe(true);
  });

  it('drops a leftover PostToolUse interrupt hook on refresh (ADR 370 move)', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readHooks();
    file.hooks['PostToolUse'] = [
      {
        hooks: [
          {
            type: 'command',
            command: `command -v musterd >/dev/null 2>&1 && musterd inbox --interrupt-check >/dev/null 2>&1 || true # ${INTERRUPT_MARKER}`,
          },
        ],
      },
    ];
    writeFileSync(hooksPath(), `${JSON.stringify(file, null, 2)}\n`);
    grok.refreshHooks!.run(cwd);
    expect(commandsOn('PostToolUse').some((c) => c.includes(INTERRUPT_MARKER))).toBe(false);
  });

  it('reports drift while a leftover PostToolUse interrupt hook is still installed', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readHooks();
    file.hooks['PostToolUse'] = [
      {
        hooks: [
          {
            type: 'command',
            command: `command -v musterd >/dev/null 2>&1 && musterd inbox --interrupt-check >/dev/null 2>&1 || true # ${INTERRUPT_MARKER}`,
          },
        ],
      },
    ];
    writeFileSync(hooksPath(), JSON.stringify(file));
    const drift = inspectGrokHookDrift(cwd);
    expect(drift.some((d) => d.includes('leftover') && d.includes('PostToolUse'))).toBe(true);
  });
});

function runNode(script: string, stdin: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['-e', script], {
    input: stdin,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function fakeMusterd(dir: string, stdout: string): string {
  const bin = join(dir, 'musterd');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' ${JSON.stringify(stdout)}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

describe('grok interrupt scripts (ADR 370)', () => {
  it('wraps a non-empty interrupt line as PreToolUse additionalContext and stays silent when empty', () => {
    const hit = runNode(GROK_INTERRUPT_PRE_WRAP, 'urgent from nick\n');
    expect(hit.status).toBe(0);
    expect(JSON.parse(hit.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'urgent from nick',
      },
    });
    const miss = runNode(GROK_INTERRUPT_PRE_WRAP, '  \n');
    expect(miss.status).toBe(0);
    expect(miss.stdout).toBe('');
  });

  it('Stop blocks a genuine end_turn once, and ignores shutdown / already-continued', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'musterd-fake-'));
    try {
      const env = {
        PATH: `${fakeMusterd(binDir, 'urgent from nick')}:${process.env['PATH'] ?? ''}`,
      };
      const block = runNode(
        GROK_INTERRUPT_STOP_SCRIPT,
        JSON.stringify({ reason: 'end_turn' }),
        env,
      );
      expect(block.status).toBe(0);
      expect(JSON.parse(block.stdout)).toEqual({ decision: 'block', reason: 'urgent from nick' });

      const continued = runNode(
        GROK_INTERRUPT_STOP_SCRIPT,
        JSON.stringify({ reason: 'end_turn', stopHookActive: true }),
        env,
      );
      expect(continued.status).toBe(0);
      expect(continued.stdout).toBe('');

      const shutdown = runNode(
        GROK_INTERRUPT_STOP_SCRIPT,
        JSON.stringify({ reason: 'shutdown' }),
        env,
      );
      expect(shutdown.status).toBe(0);
      expect(shutdown.stdout).toBe('');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('Stop stays silent when interrupt-check prints nothing', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'musterd-fake-'));
    try {
      const env = { PATH: `${fakeMusterd(binDir, '')}:${process.env['PATH'] ?? ''}` };
      const idle = runNode(GROK_INTERRUPT_STOP_SCRIPT, JSON.stringify({ reason: 'end_turn' }), env);
      expect(idle.status).toBe(0);
      expect(idle.stdout).toBe('');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
