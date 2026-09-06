import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_IDLE_BELL_CAP,
  OPENCODE_PLUGIN_GENERATION,
  OPENCODE_PLUGIN_MARKER,
  OPENCODE_PLUGIN_SURFACE,
  inspectOpencodePluginDrift,
  installMusterdOpencodePlugin,
  installedPluginGeneration,
  opencodePluginHeader,
  opencodePluginPath,
  removeMusterdOpencodePlugin,
  renderOpencodePlugin,
} from './opencodePlugin.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-opencode-plugin-'));
  dirs.push(dir);
  return dir;
}

describe('OpenCode doorbell plugin install / drift / remove (ADR 392, ADR 168)', () => {
  it('writes a marker-stamped, dependency-free ESM plugin and reads back as current', () => {
    const dir = tmpProject();
    expect(installMusterdOpencodePlugin(dir)).toEqual([]);
    const raw = readFileSync(opencodePluginPath(dir), 'utf8');
    expect(raw.startsWith(opencodePluginHeader())).toBe(true);
    expect(installedPluginGeneration(raw)).toBe(OPENCODE_PLUGIN_GENERATION);
    // node built-ins only: no bun install step, no package.json (ADR 362 finding 2 met, not waived)
    const imports = raw.match(/^import .* from "(.+)";$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/from "node:/);
    expect(raw).toContain('"tool.execute.after"');
    expect(raw).toContain('"session.idle"');
    expect(raw).not.toContain('experimental.');
    expect(inspectOpencodePluginDrift(dir)).toEqual([]);
  });

  it('names a missing plugin as the deaf state, and a stale one as STALE with the refresh repair', () => {
    const dir = tmpProject();
    const missing = inspectOpencodePluginDrift(dir);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('nothing probes the interrupt line');
    expect(missing[0]).toContain('musterd init --refresh-hooks');

    mkdirSync(join(dir, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(
      opencodePluginPath(dir),
      `${opencodePluginHeader(0)}\nexport const MusterdInterrupt = async () => ({});\n`,
    );
    const stale = inspectOpencodePluginDrift(dir);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('STALE');
    expect(stale[0]).toContain('v0');
    // and the refresh rewrites an OLDER generation in place
    expect(installMusterdOpencodePlugin(dir)).toEqual([]);
    expect(inspectOpencodePluginDrift(dir)).toEqual([]);
  });

  it('refuses to downgrade a plugin written by a newer build (ADR 168) and to clobber a foreign file (ADR 027)', () => {
    const dir = tmpProject();
    mkdirSync(join(dir, '.opencode', 'plugins'), { recursive: true });
    const newer = `${opencodePluginHeader(OPENCODE_PLUGIN_GENERATION + 1)}\nexport const X = async () => ({});\n`;
    writeFileSync(opencodePluginPath(dir), newer);
    const w = installMusterdOpencodePlugin(dir);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('newer musterd build');
    expect(readFileSync(opencodePluginPath(dir), 'utf8')).toBe(newer);

    const foreign = "// somebody else's plugin\nexport const Theirs = async () => ({});\n";
    writeFileSync(opencodePluginPath(dir), foreign);
    const w2 = installMusterdOpencodePlugin(dir);
    expect(w2).toHaveLength(1);
    expect(w2[0]).toContain("not musterd's");
    expect(readFileSync(opencodePluginPath(dir), 'utf8')).toBe(foreign);
    expect(inspectOpencodePluginDrift(dir)[0]).toContain("not musterd's");
    removeMusterdOpencodePlugin(dir);
    expect(readFileSync(opencodePluginPath(dir), 'utf8')).toBe(foreign);
  });

  it('honours a declined opencode:plugin surface (ADR 332): no install, no drift', () => {
    const dir = tmpProject();
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'declined.json'),
      JSON.stringify({
        version: 1,
        declined: [{ surface: OPENCODE_PLUGIN_SURFACE, at: '2026-09-06T00:00:00Z' }],
      }),
    );
    expect(installMusterdOpencodePlugin(dir)).toEqual([]);
    expect(inspectOpencodePluginDrift(dir)).toEqual([]);
  });

  it('removes exactly our file', () => {
    const dir = tmpProject();
    installMusterdOpencodePlugin(dir);
    removeMusterdOpencodePlugin(dir);
    expect(inspectOpencodePluginDrift(dir)[0]).toContain('missing');
  });
});

/**
 * The plugin executed for real, in a node subprocess (the same node built-ins Bun serves inside
 * OpenCode; a subprocess because vite will not import a file from outside the project), against a
 * fake `musterd` on PATH that prints whatever MUSTERD_FAKE_LINE says. What the shape pins IS the
 * delivery: a raised line lands in the tool output the model reads, and an idle bell becomes one
 * capped reply-mode prompt.
 */
describe('OpenCode doorbell plugin behaviour', () => {
  function run(dir: string, line: string, scenario: string, env: Record<string, string> = {}) {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'musterd');
    writeFileSync(
      fake,
      // records cwd and args so the test can assert the probe ran in the seat folder
      `#!/bin/sh\nprintf '%s %s\\n' "$PWD" "$*" >> "${join(dir, 'calls.log')}"\nif [ -n "$MUSTERD_FAKE_LINE" ]; then printf '%s\\n' "$MUSTERD_FAKE_LINE"; fi\n`,
    );
    chmodSync(fake, 0o755);
    const pluginFile = join(dir, 'musterd-plugin.mjs');
    writeFileSync(pluginFile, renderOpencodePlugin());
    const script = `const { MusterdInterrupt } = await import(${JSON.stringify(pathToFileURL(pluginFile).href)});\n${scenario}`;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        MUSTERD_FAKE_LINE: line,
        MUSTERD_NO_NUDGE: '',
        ...env,
      },
    });
    if (res.status !== 0) throw new Error(`plugin scenario failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  }

  it('appends a raised line, fenced, to the tool output; silent when the probe prints nothing', () => {
    const dir = tmpProject();
    const seat = join(dir, 'seat');
    mkdirSync(seat);
    const r = run(
      dir,
      'musterd: nick steered you — run team_inbox_check',
      `const hooks = await MusterdInterrupt({ client: {}, directory: ${JSON.stringify(seat)} });
       const out = { title: 't', output: 'file contents', metadata: {} };
       await hooks['tool.execute.after']({}, out);
       process.env.MUSTERD_FAKE_LINE = '';
       const quiet = { title: 't', output: 'unchanged', metadata: {} };
       await hooks['tool.execute.after']({}, quiet);
       console.log(JSON.stringify({ out: out.output, quiet: quiet.output }));`,
    );
    expect(r['out']).toBe(
      'file contents\n\n<musterd-interrupt>\nmusterd: nick steered you — run team_inbox_check\n</musterd-interrupt>',
    );
    expect(r['quiet']).toBe('unchanged');
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('inbox --interrupt-check');
    expect(calls[0]!.startsWith(seat) || calls[0]!.startsWith(`/private${seat}`)).toBe(true);
  });

  it('rings an idle session with one reply-mode prompt per raised line, capped per session', () => {
    const dir = tmpProject();
    const r = run(
      dir,
      'musterd: a huddle turn is yours',
      `const prompts = [];
       const client = { session: { promptAsync: async (req) => void prompts.push(req) } };
       const hooks = await MusterdInterrupt({ client, directory: ${JSON.stringify(dir)} });
       const idle = { event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } };
       for (let i = 0; i < ${String(OPENCODE_IDLE_BELL_CAP)} + 3; i++) await hooks.event(idle);
       const afterCap = prompts.length;
       await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_2' } } });
       await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_3' } } });
       console.log(JSON.stringify({ afterCap, total: prompts.length, first: prompts[0] }));`,
    );
    expect(r['afterCap']).toBe(OPENCODE_IDLE_BELL_CAP);
    expect(r['total']).toBe(OPENCODE_IDLE_BELL_CAP + 1);
    expect(r['first']).toEqual({
      path: { id: 'ses_1' },
      body: { parts: [{ type: 'text', text: 'musterd: a huddle turn is yours', synthetic: true }] },
    });
  });

  it('MUSTERD_NO_NUDGE=1 mutes the plugin without running the CLI', () => {
    const dir = tmpProject();
    const r = run(
      dir,
      'should never print',
      `const hooks = await MusterdInterrupt({ client: {}, directory: ${JSON.stringify(dir)} });
       const out = { title: 't', output: 'x', metadata: {} };
       await hooks['tool.execute.after']({}, out);
       console.log(JSON.stringify({ out: out.output }));`,
      { MUSTERD_NO_NUDGE: '1' },
    );
    expect(r['out']).toBe('x');
    expect(() => readFileSync(join(dir, 'calls.log'))).toThrow();
  });

  it('marker constant matches the header the doctor greps for', () => {
    expect(opencodePluginHeader()).toContain(`// ${OPENCODE_PLUGIN_MARKER} v`);
  });
});
