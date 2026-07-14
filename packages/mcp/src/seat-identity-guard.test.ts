import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findBinding, resolveBindingDir } from './binding.js';

/**
 * The seat-identity guard (ADR 143) — a regression suite for a real incident, written to reproduce it.
 *
 * On 2026-07-13, `musterd agent dolly` (run from the shared repo root) registered the MCP server with
 * `MUSTERD_BINDING=<...>/agents-dolly/.musterd/binding.json` in Claude Code's **local** scope. That scope
 * is keyed by **repo root**, and every seat worktree is a git worktree of the same repo — so all of them
 * shared the entry. Every live session on the machine booted its adapter as `dolly`, and the daemon
 * superseded them against each other. Two agents lost their identity mid-task.
 *
 * The invariant these tests pin:
 *
 *   **If the workspace you are running in has its own seat, that seat is who you are.**
 *
 * ...while leaving genuine host-injection (a workspace with *no* seat) working, which is the only thing
 * `MUSTERD_BINDING` was ever for.
 */

let root: string;
/** Two sibling seat worktrees of one repo — the exact shape that produced the incident. */
let miley: string;
let dolly: string;

const seat = (dir: string, name: string): string => {
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  const p = join(dir, '.musterd', 'binding.json');
  writeFileSync(
    p,
    JSON.stringify({
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      agent_key: `mskey_${name}`,
      surface: 'claude-code',
      claim: { mode: 'seat', name },
    }),
  );
  return p;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'musterd-seat-guard-'));
  miley = join(root, 'agents-miley');
  dolly = join(root, 'agents-dolly');
  seat(miley, 'miley');
  seat(dolly, 'dolly');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the cross-worktree seat leak', () => {
  /** The incident, exactly: miley's adapter, handed dolly's binding by a shared harness config.
   * A function, not a const — the temp worktrees don't exist until `beforeEach`. */
  const leaked = (): NodeJS.ProcessEnv => ({
    MUSTERD_BINDING: join(dolly, '.musterd', 'binding.json'),
  });

  it('refuses a MUSTERD_BINDING that belongs to another workspace', () => {
    // Before the guard this returned `dolly` — and every session on the machine became dolly.
    expect(findBinding(miley, leaked())?.claim.name).toBe('miley');
  });

  it('never writes a claimed seat back into the other workspace (the clobber this would have become)', () => {
    // resolveBindingDir decides where a claim is persisted. Un-guarded, miley's adapter would have
    // overwritten *dolly's* binding.json with miley's seat.
    expect(resolveBindingDir(miley, leaked())).toBe(miley);
  });

  it('says so out loud — a silently-swapped identity is how this went unnoticed for hours', () => {
    const err = vi.spyOn(console, 'error');
    findBinding(miley, leaked());
    expect(err).toHaveBeenCalledOnce();
    expect(err.mock.calls[0]?.[0]).toMatch(/refusing MUSTERD_BINDING/);
  });

  it('warns on stderr, never stdout — stdout is the MCP stdio transport', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    findBinding(miley, leaked());
    expect(out).not.toHaveBeenCalled();
  });

  it('is symmetric — the guard is about *where you are*, not about who leaked', () => {
    const other = { MUSTERD_BINDING: join(miley, '.musterd', 'binding.json') };
    expect(findBinding(dolly, other)?.claim.name).toBe('dolly');
  });
});

describe('what the guard must NOT break', () => {
  it('honours MUSTERD_BINDING when the workspace has no seat of its own (real host injection)', () => {
    // This is the only case the env var was ever for: a host injecting an identity into a bare workspace.
    const bare = join(root, 'bare');
    mkdirSync(bare, { recursive: true });
    const env = { MUSTERD_BINDING: join(dolly, '.musterd', 'binding.json') };
    expect(findBinding(bare, env)?.claim.name).toBe('dolly');
    expect(resolveBindingDir(bare, env)).toBe(dolly);
  });

  it('honours MUSTERD_BINDING that names this same workspace (belt and braces, not a leak)', () => {
    const env = { MUSTERD_BINDING: join(miley, '.musterd', 'binding.json') };
    expect(findBinding(miley, env)?.claim.name).toBe('miley');
    expect(resolveBindingDir(miley, env)).toBe(miley);
  });

  it('still resolves the workspace seat with no env at all', () => {
    expect(findBinding(miley, {})?.claim.name).toBe('miley');
    expect(resolveBindingDir(miley, {})).toBe(miley);
  });

  it('resolves from a subdirectory of the workspace, not just its root', () => {
    const sub = join(miley, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    expect(findBinding(sub, {})?.claim.name).toBe('miley');
    expect(resolveBindingDir(sub, {})).toBe(miley);
  });
});
