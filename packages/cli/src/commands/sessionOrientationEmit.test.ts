import { afterEach, describe, expect, it } from 'vitest';
import { emitSessionOrientation } from './session.js';

afterEach(() => {
  delete process.env['MUSTERD_PROVENANCE'];
});

describe('emitSessionOrientation', () => {
  it('is silent under wake provenance — the fetcher is never even called', async () => {
    process.env['MUSTERD_PROVENANCE'] = 'wake';
    expect(
      await emitSessionOrientation(() => {
        throw new Error('must not fetch');
      }),
    ).toBeNull();
  });

  it('is silent when the folder has no bound seat (fetcher resolves null)', async () => {
    expect(await emitSessionOrientation(() => Promise.resolve(null))).toBeNull();
  });

  it('renders the orientation from fetched parts', async () => {
    const out = await emitSessionOrientation(() =>
      Promise.resolve({
        seat: 'dolly',
        team: 'revive',
        memory: { headline: 'wrap note', saved_at: Date.now(), size_bytes: 9 },
        waiting: [],
        incidents: [],
        owed: [],
        carrying: 2,
      }),
    );
    expect(out).toContain('carrying: 2 lane(s) in flight');
    expect(out).toContain('musterd orientation — seat "dolly"');
  });

  it('swallows fetcher failure (hook contract: never fail, never noise)', async () => {
    expect(await emitSessionOrientation(() => Promise.reject(new Error('daemon down')))).toBeNull();
  });
});
