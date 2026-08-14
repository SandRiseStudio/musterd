import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMcpConfig, refreshAttestation } from './config.js';

/**
 * Surface drift — occupancy follows capture (ADR 275).
 *
 * `surface` still resolves `env > binding.json > committed workspace.json` as the *declaration*.
 * When `binding.session.harness` (else `model_observed.harness`) is a valid Surface, occupancy
 * attests that value — the same class of evidence ADR 158 already trusts for model. Two
 * declarations still win: `MUSTERD_SURFACE` in env, and native `musterd` (ADR 251).
 *
 * The 2026-08-03 warning believed the declaration and printed the contradiction. Measured again
 * 2026-08-14: a Cursor slot (`session.harness: cursor`) with `binding.surface: claude-code`
 * occupied as claude-code. A warning that the roster will lie does not stop the roster lying.
 *
 * Warn only when occupancy will still attest the stale value (env override, or native musterd
 * vs a capture). Silent when occupancy follows capture. Silent when nothing has been captured
 * — Codex has no hook path, so warning on absence would fire forever.
 */

let dir: string;
let errors: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-surface-drift-'));
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.join(' '));
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A binding with a declared surface, and optionally the evidence of what actually ran. */
const writeBinding = (over: Record<string, unknown>): void =>
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      agent_key: 'mskey_test',
      claim: { mode: 'seat', name: 'miley' },
      model: 'claude-opus-5',
      ...over,
    }),
  );

const warning = (): string => errors.join('\n');

describe('occupancy follows capture (ADR 275)', () => {
  it('is the measured case: cursor declared, claude-code captured — occupancy is claude-code', () => {
    writeBinding({
      surface: 'cursor',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    const config = loadMcpConfig({});
    expect(config.surface).toBe('claude-code');
    expect(warning()).not.toMatch(/reports surface/);
  });

  it('falls back to the model observation when there is no session capture', () => {
    writeBinding({
      surface: 'cursor',
      model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 1 },
    });
    const config = loadMcpConfig({});
    expect(config.surface).toBe('claude-code');
    expect(warning()).not.toMatch(/reports surface/);
  });

  it('session harness wins over a stale model-observation harness', () => {
    writeBinding({
      surface: 'codex',
      session: { harness: 'cursor', id: 's1', started_at: 1 },
      model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 1 },
    });
    expect(loadMcpConfig({}).surface).toBe('cursor');
  });

  it('ignores a capture harness that is not a Surface — occupancy stays the declaration', () => {
    writeBinding({
      surface: 'codex',
      session: { harness: 'cursor-agent', id: 's1', started_at: 1 },
    });
    expect(loadMcpConfig({}).surface).toBe('codex');
    expect(warning()).not.toMatch(/reports surface/);
  });

  it('stays silent when the declaration and the capture agree — every other seat measured', () => {
    writeBinding({
      surface: 'claude-code',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
      model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 1 },
    });
    loadMcpConfig({});
    expect(warning()).not.toMatch(/reports surface/);
  });

  it('stays silent when nothing has ever been captured — a declaration alone is not a contradiction', () => {
    // The overwhelming majority of seats: provisioned, never yet run under a hook-capable harness.
    // Codex is permanently in this state (it has no hook path at all), so warning here would fire
    // forever on every Codex seat and teach the reader to ignore it.
    writeBinding({ surface: 'codex' });
    const config = loadMcpConfig({});
    expect(config.surface).toBe('codex');
    expect(warning()).not.toMatch(/reports surface/);
  });

  it('refreshAttestation picks up a mid-session harness heal', () => {
    writeBinding({ surface: 'claude-code' });
    const config = loadMcpConfig({});
    expect(config.surface).toBe('claude-code');
    writeBinding({
      surface: 'claude-code',
      session: { harness: 'cursor', id: '28c22bee', started_at: 2 },
    });
    refreshAttestation(config, {});
    expect(config.surface).toBe('cursor');
  });

  it('refreshAttestation does not clobber a host-declared musterd occupancy', () => {
    writeBinding({
      surface: 'cursor',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    const config = loadMcpConfig({});
    config.surface = 'musterd';
    refreshAttestation(config, {});
    expect(config.surface).toBe('musterd');
  });
});

describe('a declaration occupancy will still lie about', () => {
  it('names the env as the culprit when the stale value is baked there — the measured cause', () => {
    // miley's `.cursor/mcp.json` predates ADR 165 and bakes MUSTERD_SURFACE at the top of the ladder,
    // where no observation can reach it. Occupancy uses the env (ADR 275 §2). Saying "fix your
    // binding" would send the reader to the wrong file.
    writeBinding({
      surface: 'codex',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    const config = loadMcpConfig({ MUSTERD_SURFACE: 'cursor' });

    expect(config.surface).toBe('cursor'); // env still wins — do not re-rank above env
    expect(warning()).toContain('MUSTERD_SURFACE');
    expect(warning()).toContain('cursor'); // the env value is what won, so it is what we warn about
  });

  it('does not promote capture above MUSTERD_SURFACE — this warns, it does not re-rank env', () => {
    writeBinding({
      surface: 'codex',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    const config = loadMcpConfig({ MUSTERD_SURFACE: 'cursor' });
    expect(config.surface).toBe('cursor');
  });

  it('warns when native musterd disagrees with capture, and does not clobber occupancy', () => {
    writeBinding({
      surface: 'musterd',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    const config = loadMcpConfig({});
    expect(config.surface).toBe('musterd');
    expect(warning()).toContain('musterd');
    expect(warning()).toContain('claude-code');
    expect(warning()).toContain('ADR 251');
  });

  it('warns on stderr, never stdout — stdout is the MCP stdio transport', () => {
    writeBinding({
      surface: 'codex',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    loadMcpConfig({ MUSTERD_SURFACE: 'cursor' });
    expect(stdout).not.toHaveBeenCalled();
  });
});

/**
 * The prescription — what the warning tells the reader to DO.
 *
 * Everything above tests detection. Nothing tested the fix, which is how this message came to
 * prescribe `musterd wire` / `musterd agent <seat>`: both re-provision through `harness.configure`,
 * which rewrites the `claude mcp -s local` entry — a slot Claude Code keys by repo ROOT, and so
 * shares across every `agents-*` seat worktree (ADR 143). Repairing one stale string in one seat's
 * gitignored binding rewrote the entry every seat on the machine launches through.
 *
 * These tests bind the narrowed prescription: it may name only the file that actually holds the
 * stale value. Binding-vs-capture is no longer a warning (occupancy follows capture); the env
 * override is.
 */
describe('the repair it prescribes', () => {
  /** The commands that re-provision, i.e. that rewrite the repo-root-shared MCP entry. Kept honest
   *  by the source guard at the bottom of this file rather than by memory. */
  const SHARED_ENTRY_WRITERS = ['musterd agent', 'musterd init', 'musterd wire'];

  const expectNoWideWrite = (): void => {
    for (const cmd of SHARED_ENTRY_WRITERS) expect(warning()).not.toContain(cmd);
  };

  it('repairs the baked env by deleting that one value, not by re-wiring the entry', () => {
    writeBinding({
      surface: 'codex',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    loadMcpConfig({ MUSTERD_SURFACE: 'cursor' });

    expect(warning()).toContain('MUSTERD_SURFACE');
    expect(warning()).toMatch(/delete/i);
    // `musterd wire` would remove it — and re-point command/args and reinstall hooks for every seat
    // worktree sharing the slot, to unset one string in one of them.
    expectNoWideWrite();
  });

  it('does not tell the reader to overwrite a host-declared musterd occupancy', () => {
    writeBinding({
      surface: 'musterd',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    loadMcpConfig({});
    expect(warning()).not.toMatch(/set it to "claude-code"/);
    expectNoWideWrite();
  });

  /**
   * The guard that would have caught this. `SHARED_ENTRY_WRITERS` above is only as good as its
   * accuracy, so derive the real set from the CLI: every command whose source calls `.configure(`
   * on a harness adapter rewrites the shared entry. If a fourth one appears, this fails — and
   * whoever added it has to look at what this warning (and any other prescription) tells people to
   * run before it can go green.
   */
  it('knows every command that rewrites the shared entry — a new one fails this test', () => {
    const commandsDir = fileURLToPath(new URL('../../cli/src/commands/', import.meta.url));
    const found = readdirSync(commandsDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /\.configure\(/.test(readFileSync(join(commandsDir, f), 'utf8')))
      .map((f) => `musterd ${f.replace(/\.ts$/, '')}`);
    // `init` provisions from packages/cli/src/onboard/init.ts, not a commands/ file, so it is not
    // discovered here — it is a known writer and stays in the list unconditionally.
    expect(new Set([...found, 'musterd init'])).toEqual(new Set(SHARED_ENTRY_WRITERS));
  });
});
