import { SEAT_CHIP } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import { emitSessionStatusline } from './session.js';
import type { SessionStatuslineInput } from './sessionStatusline.js';

const input: SessionStatuslineInput = {
  seat: 'dolly',
  team: 'revive',
  waiting: 2,
  incidents: 0,
  carrying: 0,
};

/**
 * The emit layer decides silence and anchoring; composition is covered in sessionStatusline.test.ts.
 * ryder's #1076 review flagged this layer as untested — and named why it matters: anchoring is
 * exactly where miley's #1072 finding landed, and a live falsifier covers today while a test covers
 * next month.
 */
describe('emitSessionStatusline', () => {
  it('renders the chip from the fetcher it is given', async () => {
    const out = await emitSessionStatusline('/w', () => Promise.resolve(input));
    expect(out).toBe(`${SEAT_CHIP} dolly · revive · ⚑2 waiting · lane: none`);
  });

  it('passes the ANCHORED dir through — never a bare cwd', async () => {
    // The one derivation (resolveCaptureDir) is applied by the caller; what this layer must not do
    // is substitute anything of its own. A chip naming the wrong seat would mislead all session.
    const fetch = vi.fn().mockResolvedValue(input);
    await emitSessionStatusline('/seats/miley', fetch);
    expect(fetch).toHaveBeenCalledWith('/seats/miley');
  });

  it('renders nothing when the workspace has no usable binding', async () => {
    expect(await emitSessionStatusline(null, () => Promise.resolve(null))).toBeNull();
  });

  it('is silent, never throwing, when the fetch fails', async () => {
    const out = await emitSessionStatusline('/w', () => Promise.reject(new Error('daemon down')));
    expect(out).toBeNull();
  });

  it('gives up inside its budget when the daemon is WEDGED rather than down', async () => {
    // The failure mode that actually happens (guardian raised it five times in one day): the socket
    // is held and nothing answers. Without a bound, every redraw would hang until the harness killed
    // it. "Silence on failure" is only true if failure is bounded.
    const hang = () => new Promise<SessionStatuslineInput>(() => {}); // never settles
    const started = Date.now();
    expect(await emitSessionStatusline('/w', hang, 40)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('is NOT wake-suppressed, unlike the orientation block', async () => {
    // Suppression exists to stop the block re-priming an already-primed agent. The chip primes
    // nobody — it labels a terminal, and a woken session still needs to know which seat it is in.
    vi.stubEnv('MUSTERD_PROVENANCE', 'wake');
    try {
      expect(await emitSessionStatusline('/w', () => Promise.resolve(input))).toContain('dolly');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('admits an undercount rather than rendering a bounded prefix as a total', async () => {
    const out = await emitSessionStatusline('/w', () =>
      Promise.resolve({ ...input, waitingTruncated: true }),
    );
    expect(out).toContain('⚑2+ waiting');
  });
});
