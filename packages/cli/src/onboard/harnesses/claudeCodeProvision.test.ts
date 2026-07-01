import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only child_process (so no real `claude` runs); use the real fs against a temp cwd so the
// permission-merge / removal logic is exercised end to end.
const calls = vi.hoisted(() => [] as { file: string; args: string[] }[]);

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    opts: unknown,
    cb?: (e: null, out: string, err: string) => void,
  ) => {
    calls.push({ file, args });
    const callback = (typeof opts === 'function' ? opts : cb) as (
      e: null,
      out: string,
      err: string,
    ) => void;
    callback(null, '1.0.0', '');
  },
}));

const { claudeCode } = await import('./claudeCode.js');

let cwd: string;
let origCwd: string;
let savedConfigDir: string | undefined;
beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-ccprov-'));
  process.chdir(cwd);
  // `configure` installs the GLOBAL SessionStart hook into $CLAUDE_CONFIG_DIR/settings.json — point it
  // at the temp cwd so the suite never touches the real ~/.claude/settings.json.
  savedConfigDir = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = join(cwd, '.claude-global');
  calls.length = 0;
});
afterEach(() => {
  process.chdir(origCwd);
  if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
  else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir;
});

const settingsPath = () => join(cwd, '.claude', 'settings.local.json');

describe('claudeCode.provision — servers', () => {
  it('registers each server with per-server idempotency (remove then add), local scope', async () => {
    const result = await claudeCode.provision!(
      {
        servers: [
          {
            name: 'supabase',
            command: 'npx',
            args: ['-y', '@supabase/mcp-server-supabase@latest'],
            env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' },
          },
        ],
        permissions: { allow: [], ask: [], deny: [] },
      },
      'local',
    );
    expect(result.servers).toEqual(['supabase']);

    const mcp = calls.filter((c) => c.args[0] === 'mcp');
    const remove = mcp.find((c) => c.args[1] === 'remove' && c.args.includes('supabase'));
    const add = mcp.find((c) => c.args[1] === 'add' && c.args.includes('supabase'));
    expect(remove).toBeDefined();
    expect(add).toBeDefined();
    expect(calls.indexOf(remove!)).toBeLessThan(calls.indexOf(add!));
    expect(add!.args).toEqual(expect.arrayContaining(['-s', 'local']));
  });

  it('passes ${ENV} secrets through verbatim as a reference, never resolved/baked', async () => {
    await claudeCode.provision!({
      servers: [{ name: 's', command: 'npx', args: [], env: { TOKEN: '${MY_TOKEN}' } }],
      permissions: { allow: [], ask: [], deny: [] },
    });
    const add = calls.find((c) => c.args[1] === 'add')!;
    expect(add.args).toContain('TOKEN=${MY_TOKEN}');
  });
});

describe('claudeCode.provision — permissions', () => {
  it('merges permissions into .claude/settings.local.json and reports only newly-added', async () => {
    const result = await claudeCode.provision!({
      servers: [],
      permissions: { allow: ['edit', 'read'], ask: ['bash'], deny: [] },
    });
    expect(result.permissions.allow.sort()).toEqual(['edit', 'read']);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.permissions.allow).toEqual(expect.arrayContaining(['edit', 'read']));
    expect(written.permissions.ask).toEqual(['bash']);
  });

  it('is additive — keeps the user’s existing entries and does not double-add', async () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ permissions: { allow: ['read', 'mine'] } }));
    const result = await claudeCode.provision!({
      servers: [],
      permissions: { allow: ['read', 'edit'], ask: [], deny: [] },
    });
    // only 'edit' is newly added; 'read' was already present
    expect(result.permissions.allow).toEqual(['edit']);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.permissions.allow).toEqual(['read', 'mine', 'edit']);
  });

  it('writes nothing when there are no servers and no permissions', async () => {
    const result = await claudeCode.provision!({
      servers: [],
      permissions: { allow: [], ask: [], deny: [] },
    });
    expect(result.permissions.allow).toEqual([]);
    expect(existsSync(settingsPath())).toBe(false);
  });
});

describe('claudeCode.unprovision', () => {
  it('removes the named servers and exactly the listed permissions, keeping the rest', async () => {
    // seed settings with a user entry + a provisioned one
    const dir = join(cwd, '.claude');
    await claudeCode.provision!({
      servers: [],
      permissions: { allow: ['edit'], ask: [], deny: [] },
    });
    writeFileSync(
      join(dir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['edit', 'mine'] } }),
    );
    calls.length = 0;

    await claudeCode.unprovision!(
      { servers: ['supabase', 'musterd'], permissions: { allow: ['edit'], ask: [], deny: [] } },
      'local',
    );

    // both servers asked to be removed
    const removed = calls.filter((c) => c.args[1] === 'remove').flatMap((c) => c.args);
    expect(removed).toEqual(expect.arrayContaining(['supabase', 'musterd']));
    // only the provisioned permission is gone; the user's 'mine' stays
    const written = JSON.parse(readFileSync(join(dir, 'settings.local.json'), 'utf8'));
    expect(written.permissions.allow).toEqual(['mine']);
  });

  it('is a no-op when there is no settings file', async () => {
    await expect(
      claudeCode.unprovision!({
        servers: ['musterd'],
        permissions: { allow: ['x'], ask: [], deny: [] },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('claudeCode notification hook (ADR 053)', () => {
  const entry = { command: 'node', args: ['mcp.js'], env: { MUSTERD_TEAM: 'dawn' } };
  const binding = { team: 'dawn', member: 'Ada', token: 't', surface: 'claude-code' as const };

  it('configure installs a Notification hook that runs `musterd nudge`, marked for reversal', async () => {
    await claudeCode.configure(entry, binding);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const hooks = written.hooks.Notification as { hooks: { command: string }[] }[];
    expect(hooks).toHaveLength(1);
    const cmd = hooks[0].hooks[0].command;
    expect(cmd).toContain('musterd nudge');
    expect(cmd).toContain('musterd-notify-hook');
  });

  it('is idempotent — re-configuring replaces musterd’s entry instead of stacking', async () => {
    await claudeCode.configure(entry, binding);
    await claudeCode.configure(entry, binding);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.hooks.Notification).toHaveLength(1);
  });

  it('preserves the user’s own Notification hooks and other events', async () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          Notification: [{ hooks: [{ type: 'command', command: 'my-own-thing' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }],
        },
      }),
    );
    await claudeCode.configure(entry, binding);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const cmds = written.hooks.Notification.map(
      (m: { hooks: { command: string }[] }) => m.hooks[0].command,
    );
    expect(cmds).toContain('my-own-thing'); // user's hook kept
    expect(cmds.some((c: string) => c.includes('musterd-notify-hook'))).toBe(true); // ours added
    expect(written.hooks.Stop).toHaveLength(1); // untouched event
  });

  it('unprovision removes only musterd’s hook, leaving the user’s', async () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: { Notification: [{ hooks: [{ type: 'command', command: 'my-own-thing' }] }] },
      }),
    );
    await claudeCode.configure(entry, binding); // adds ours alongside the user's
    await claudeCode.unprovision!({
      servers: ['musterd'],
      permissions: { allow: [], ask: [], deny: [] },
    });
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    const cmds = written.hooks.Notification.map(
      (m: { hooks: { command: string }[] }) => m.hooks[0].command,
    );
    expect(cmds).toEqual(['my-own-thing']); // ours gone, user's kept
  });
});
