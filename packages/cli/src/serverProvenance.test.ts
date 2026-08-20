import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBinding, serverProvenance } from './config.js';

/**
 * Where did this server URL come from? (lane 01KZVKF3H0R81XEA818G2QBRZC, read side.)
 *
 * `service status` and `stream doctor` both resolve the daemon from `loadConfig().server` — the
 * MACHINE-WIDE default — and then report on it without ever saying so. On 2026-08-12 that default
 * had been repointed at a probe daemon, so both tools failed four checks correctly about the wrong
 * port. The failure is expensive precisely because every reader is confidently wrong in the SAME
 * direction: the output looks exactly like infrastructure being down.
 *
 * Naming the source turns that into a one-line tell. The disagreeing-binding case is the whole
 * point: the folder you are standing in says one thing, the machine default says another, and the
 * tool reads the machine default.
 */
describe('serverProvenance', () => {
  let dir: string;
  let cfg: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-prov-'));
    cfg = join(dir, 'config.json');
    process.env['MUSTERD_CONFIG'] = cfg;
    delete process.env['MUSTERD_SERVER'];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_CONFIG'];
    delete process.env['MUSTERD_SERVER'];
  });

  function writeConfig(server?: string): void {
    writeFileSync(cfg, JSON.stringify(server ? { server } : {}));
  }

  it('names the built-in default when nothing has ever been configured', () => {
    const p = serverProvenance(dir);
    expect(p.server).toBe('http://localhost:4849');
    expect(p.source).toBe('built-in default');
  });

  it('names the machine default when the config file carries one', () => {
    writeConfig('http://127.0.0.1:4899');
    const p = serverProvenance(dir);
    expect(p.server).toBe('http://127.0.0.1:4899');
    expect(p.source).toBe('machine default');
  });

  it('names the environment when MUSTERD_SERVER overrides — it outranks the file', () => {
    writeConfig('http://127.0.0.1:4899');
    process.env['MUSTERD_SERVER'] = 'http://127.0.0.1:4900';
    const p = serverProvenance(dir);
    expect(p.server).toBe('http://127.0.0.1:4900');
    expect(p.source).toBe('MUSTERD_SERVER');
  });

  it('reports no disagreement when the folder has no binding', () => {
    writeConfig('http://127.0.0.1:4849');
    expect(serverProvenance(dir).disagreeingBinding).toBeUndefined();
  });

  it('reports no disagreement when the binding agrees with the machine default', () => {
    writeConfig('http://127.0.0.1:4849');
    const workdir = join(dir, 'work');
    mkdirSync(workdir);
    saveBinding(workdir, {
      version: 2,
      server: 'http://127.0.0.1:4849',
      team: 'dawn',
      agent_key: 'mscr_x',
      claim: { mode: 'seat', name: 'nick' },
    });
    expect(serverProvenance(workdir).disagreeingBinding).toBeUndefined();
  });

  it('SURFACES the disagreement — this folder is bound elsewhere than what the tool measured', () => {
    // The 2026-08-12 shape exactly: the machine default was repointed at a probe daemon while the
    // folder stayed bound to the real one.
    writeConfig('http://127.0.0.1:4899');
    const workdir = join(dir, 'work');
    mkdirSync(workdir);
    saveBinding(workdir, {
      version: 2,
      server: 'http://127.0.0.1:4849',
      team: 'dawn',
      agent_key: 'mscr_x',
      claim: { mode: 'seat', name: 'nick' },
    });
    const p = serverProvenance(workdir);
    expect(p.server).toBe('http://127.0.0.1:4899');
    expect(p.source).toBe('machine default');
    expect(p.disagreeingBinding).toEqual({ server: 'http://127.0.0.1:4849', team: 'dawn' });
  });

  it('survives a pre-ADR-281 binding — the read is advisory, so `stream ensure` keeps ticking (#928 fallout)', () => {
    // The streamwatch supervisor died every 60s on exactly this: serverProvenance's
    // disagreeing-binding diagnostic tripping the legacy-binding throw for a verb that needs no
    // workspace identity at all.
    writeConfig('http://127.0.0.1:4899');
    const workdir = join(dir, 'legacy-ws');
    mkdirSync(join(workdir, '.musterd'), { recursive: true });
    writeFileSync(
      join(workdir, '.musterd', 'binding.json'),
      JSON.stringify({
        server: 'http://127.0.0.1:4849',
        team: 'dawn',
        surface: 'claude-code',
        agent_key: 'mskey_x',
        claim: { mode: 'seat', name: 'Ada' },
      }),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = serverProvenance(workdir);
      expect(p.server).toBe('http://127.0.0.1:4899');
      // The unusable binding cannot supply the disagreement diagnostic — that is the honest read.
      expect(p.disagreeingBinding).toBeUndefined();
      // …but the repair was said out loud, once.
      expect(spy.mock.calls.join('\n')).toContain('musterd harness configure');
    } finally {
      spy.mockRestore();
    }
  });
});
