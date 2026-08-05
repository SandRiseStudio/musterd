import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMcpConfig } from './config.js';

/**
 * Surface drift — the declared harness contradicted by the one that actually ran.
 *
 * `surface` resolves `env > binding.json > committed workspace.json` and is then simply believed.
 * Unlike `model`, it never got an observation path: the ADR 158 work built `observeModel` /
 * `refreshModelObservation` to correct the model at the tool boundary, and left surface on whatever
 * declaration it was born with.
 *
 * Measured across the fleet 2026-08-03 — eleven seat worktrees, one disagreement:
 *
 *   miley   declared surface `cursor`   ·   session.harness `claude-code`   ·   observation by `claude-code`
 *
 * Only one side of that has evidence behind it. A hook is harness-specific by construction: the
 * Claude Code capture hook writes `harness: 'claude-code'`, the Cursor hook writes `'cursor'`, so a
 * capture in the binding is proof that harness actually ran here. The declaration is proof of
 * nothing — and in the measured case it came from a `MUSTERD_SURFACE` baked into a pre-ADR-165
 * `.cursor/mcp.json`, sitting at the TOP of the ladder where nothing can correct it.
 *
 * Deliberately NOT changing precedence. Promoting the observation above `binding` would not even fix
 * the measured seat (the stale value is in `env`, one rung higher), and promoting it above `env`
 * would break the documented manual override. Whatever order you pick, a baked value at the top can
 * still lie — so the fix is to make the contradiction visible, not to re-rank the liars.
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

describe('a declared surface contradicted by the harness that actually ran', () => {
  it('is the measured case: cursor declared, claude-code captured', () => {
    writeBinding({
      surface: 'cursor',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    loadMcpConfig({});

    expect(warning()).toContain('cursor'); // what we tell the team
    expect(warning()).toContain('claude-code'); // what actually ran
    expect(warning()).toContain('miley'); // which seat
  });

  it('falls back to the model observation when there is no session capture', () => {
    // `model_observed.harness` is the same class of evidence: the harness that owned the parse.
    writeBinding({
      surface: 'cursor',
      model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 1 },
    });
    loadMcpConfig({});
    expect(warning()).toContain('claude-code');
  });

  it('names the env as the culprit when the stale value is baked there — the measured cause', () => {
    // miley's `.cursor/mcp.json` predates ADR 165 and bakes MUSTERD_SURFACE at the top of the ladder,
    // where no observation can reach it. Saying "fix your binding" would send the reader to the wrong
    // file, so the warning has to name where the value it is complaining about actually came from.
    writeBinding({
      surface: 'codex',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    loadMcpConfig({ MUSTERD_SURFACE: 'cursor' });

    expect(warning()).toContain('MUSTERD_SURFACE');
    expect(warning()).toContain('cursor'); // the env value is what won, so it is what we warn about
  });

  it('stays silent when the declaration and the capture agree — every other seat measured', () => {
    writeBinding({
      surface: 'claude-code',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
      model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 1 },
    });
    loadMcpConfig({});
    // Match the contested-surface warning shape — not the bare substring "surface", which also
    // appears in tmpdir prefixes like `musterd-surface-drift-…` (and used to fail these cases when
    // ADR 213 false-positived on fixture identities; ADR 218).
    expect(warning()).not.toMatch(/reports surface/);
  });

  it('stays silent when nothing has ever been captured — a declaration alone is not a contradiction', () => {
    // The overwhelming majority of seats: provisioned, never yet run under a hook-capable harness.
    // Codex is permanently in this state (it has no hook path at all), so warning here would fire
    // forever on every Codex seat and teach the reader to ignore it.
    writeBinding({ surface: 'codex' });
    loadMcpConfig({});
    expect(warning()).not.toMatch(/reports surface/);
  });

  it('does not change what the seat actually reports — this warns, it does not re-rank', () => {
    writeBinding({
      surface: 'cursor',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    const config = loadMcpConfig({});
    // The declared surface still wins. Promoting the observation is a precedence change this
    // deliberately does not make (see the file header).
    expect(config.surface).toBe('cursor');
  });

  it('warns on stderr, never stdout — stdout is the MCP stdio transport', () => {
    writeBinding({
      surface: 'cursor',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    loadMcpConfig({});
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
 * stale value.
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

  it('repairs the binding in place, and says which worktree it means', () => {
    writeBinding({
      surface: 'cursor',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    loadMcpConfig({});

    expect(warning()).toContain('.musterd/binding.json');
    expect(warning()).toContain('this worktree only'); // per-seat, gitignored — not shared state
    expectNoWideWrite();
  });

  it('names the value to write, so the reader does not have to infer it', () => {
    writeBinding({
      surface: 'cursor',
      session: { harness: 'claude-code', id: 's1', started_at: 1 },
    });
    loadMcpConfig({});
    // The evidence side of the contradiction is the value that should be there.
    expect(warning()).toMatch(/set it to "claude-code"/);
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
