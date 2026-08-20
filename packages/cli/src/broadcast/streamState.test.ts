import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FLAP_MAX,
  FLAP_WINDOW_MS,
  decideEnsure,
  readStreamState,
  writeStreamState,
  type StreamState,
} from './streamState.js';

const NOW = 1_787_000_000_000;

function live(over: Partial<StreamState> = {}): StreamState {
  return { desired: 'live', by: 'miley', at: NOW - 60_000, team: 'revive', restarts: [], ...over };
}

/** The reconcile rule: a machine gone while desired says live is a crash — restart within the flap
 * budget, stand down at it, and never touch anything a human deliberately stopped. */
describe('decideEnsure', () => {
  it('no state at all → noop (never started, nothing to enforce)', () => {
    expect(decideEnsure({ state: null, liveCount: 0, now: NOW }).action).toBe('noop');
  });

  it('desired stopped → noop even with no machine (a deliberate stop stays stopped)', () => {
    const state = live({ desired: 'stopped', reason: 'nick asked' });
    expect(decideEnsure({ state, liveCount: 0, now: NOW }).action).toBe('noop');
  });

  it('desired live + a started machine → noop (healthy)', () => {
    expect(decideEnsure({ state: live(), liveCount: 1, now: NOW }).action).toBe('noop');
  });

  it('desired live + no machine + budget available → restart, stamping the ledger', () => {
    const d = decideEnsure({ state: live(), liveCount: 0, now: NOW });
    expect(d.action).toBe('restart');
    expect(d.state.restarts).toEqual([NOW]);
  });

  it(`stands down at the ${FLAP_MAX}rd restart inside the window and records when`, () => {
    const recent = [NOW - 20 * 60_000, NOW - 10 * 60_000, NOW - 5 * 60_000];
    const d = decideEnsure({ state: live({ restarts: recent }), liveCount: 0, now: NOW });
    expect(d.action).toBe('stand_down');
    expect(d.state.standDownAt).toBe(NOW);
  });

  it('prunes restarts older than the window — an old bad night does not spend today’s budget', () => {
    const stale = [
      NOW - FLAP_WINDOW_MS - 60_000,
      NOW - FLAP_WINDOW_MS - 30_000,
      NOW - FLAP_WINDOW_MS - 10_000,
    ];
    const d = decideEnsure({ state: live({ restarts: stale }), liveCount: 0, now: NOW });
    expect(d.action).toBe('restart');
    expect(d.state.restarts).toEqual([NOW]);
  });

  it('stood down → noop forever until a human start/stop clears it (one ask, not one per tick)', () => {
    const state = live({ restarts: [NOW - 3000, NOW - 2000, NOW - 1000], standDownAt: NOW - 500 });
    expect(decideEnsure({ state, liveCount: 0, now: NOW }).action).toBe('noop');
    // even after the flap window would have drained the ledger:
    expect(decideEnsure({ state, liveCount: 0, now: NOW + FLAP_WINDOW_MS * 2 }).action).toBe(
      'noop',
    );
  });
});

describe('stream state file', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'musterd-streamstate-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips, creating parent directories', () => {
    const p = join(dir, 'stream', 'state.json');
    const state = live({ reason: 'nick asked' });
    writeStreamState(p, state);
    expect(readStreamState(p)).toEqual(state);
  });

  it('reads null for a missing or unparseable file (fail-safe: no state, no enforcement)', () => {
    const p = join(dir, 'nope.json');
    expect(readStreamState(p)).toBeNull();
    writeStreamState(p, live());
    rmSync(p);
    expect(readStreamState(p)).toBeNull();
  });
});
