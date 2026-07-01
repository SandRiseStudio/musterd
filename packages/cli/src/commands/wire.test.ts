import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, WORKSPACE_SPEC_FILE } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';

// Capture what the harness would register, without shelling a real `claude`.
const h = vi.hoisted(() => ({
  configure: vi.fn(async () => ({ target: 'claude mcp', activation: '' })),
}));
vi.mock('../onboard/harnesses/claudeCode.js', () => ({ claudeCode: { configure: h.configure } }));

const { wireCommand } = await import('./wire.js');

let cwd: string;
let configPath: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'musterd-wire-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  configPath = join(mkdtempSync(join(tmpdir(), 'musterd-wire-cfg-')), 'config.json');
  process.env['MUSTERD_CONFIG'] = configPath;
  delete process.env['MUSTERD_AGENT_KEY'];
  delete process.env['MUSTERD_GRANT'];
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
  delete process.env['MUSTERD_CONFIG'];
  delete process.env['MUSTERD_AGENT_KEY'];
});

/** Write a committed .musterd/workspace.json (secret-free) in cwd. */
function writeSpec(spec: Record<string, unknown>) {
  mkdirSync(join(cwd, BINDING_DIR), { recursive: true });
  writeFileSync(join(cwd, BINDING_DIR, WORKSPACE_SPEC_FILE), JSON.stringify(spec), 'utf8');
}
/** Seed the global config with a team agent key. */
function writeConfig(agentKeys: Record<string, string>) {
  writeFileSync(
    configPath,
    JSON.stringify({
      server: 'http://localhost:4849',
      current: 'bravo',
      identities: {},
      knownIdentities: [],
      bindings: {},
      agentKeys,
      rosterHome: {},
    }),
    'utf8',
  );
}
function readBinding() {
  return JSON.parse(readFileSync(join(cwd, BINDING_DIR, BINDING_FILE), 'utf8'));
}
async function run(argv: string[]) {
  const out: string[] = [];
  const errs: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c: never) => (errs.push(String(c)), true));
  const code = await wireCommand(parseArgs(argv));
  return { code, out: out.join(''), err: errs.join('') };
}

const SPEC = {
  server: 'http://localhost:4849',
  team: 'bravo',
  surface: 'claude-code',
  claim: { mode: 'seat', name: 'Sonnet' },
};

describe('musterd wire', () => {
  it('registers the server from the committed spec, resolving the key from global config', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_fromconfig' });
    const { code } = await run([]);
    expect(code).toBe(0);
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_TEAM).toBe('bravo');
    expect(entry.env.MUSTERD_AGENT_KEY).toBe('mskey_fromconfig');
    // claim is not baked into the MCP env — the adapter reads it from binding.json / workspace.json
    expect(entry.env.MUSTERD_CLAIM).toBeUndefined();
    // tools only by default — no autojoin
    expect(entry.env.MUSTERD_AUTOJOIN).toBeUndefined();
    // binding.json materialized with the resolved key
    expect(readBinding().agent_key).toBe('mskey_fromconfig');
  });

  it('--autojoin opts into claim-on-launch', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_x' });
    await run(['--autojoin']);
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_AUTOJOIN).toBe('1');
  });

  it('--key overrides the config key; env is the middle precedence', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_config' });
    process.env['MUSTERD_AGENT_KEY'] = 'mskey_env';
    const flagRun = await run(['--key', 'mskey_flag']);
    expect(flagRun.code).toBe(0);
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_AGENT_KEY).toBe('mskey_flag');
  });

  it('registers keyless + warns when no key is available anywhere', async () => {
    writeSpec(SPEC);
    writeConfig({}); // no key for bravo
    const { code, err } = await run([]);
    expect(code).toBe(0);
    const entry = h.configure.mock.calls[0]![0] as { env: Record<string, string> };
    expect(entry.env.MUSTERD_AGENT_KEY).toBeUndefined(); // registered without a key
    expect(err).toMatch(/no team agent key/i);
    expect(readBinding().agent_key).toBeUndefined();
  });

  it('errors clearly when there is no committed spec', async () => {
    writeConfig({ bravo: 'mskey_x' });
    await expect(wireCommand(parseArgs([]))).rejects.toMatchObject({ exitCode: 6 });
  });

  it('never writes a secret into the committed workspace.json (it is secret-free by construction)', async () => {
    writeSpec(SPEC);
    writeConfig({ bravo: 'mskey_secret' });
    await run([]);
    // The committed spec on disk must not contain the key that landed in the binding/env.
    const specText = readFileSync(join(cwd, BINDING_DIR, WORKSPACE_SPEC_FILE), 'utf8');
    expect(specText).not.toContain('mskey_');
    // binding.json (gitignored) is where the secret lives.
    expect(existsSync(join(cwd, BINDING_DIR, BINDING_FILE))).toBe(true);
  });
});
