import { describe, expect, it, vi } from 'vitest';
import { runSessionStartProbe } from './sessionProbe.js';

describe('runSessionStartProbe', () => {
  it('passes the hook workspace to the probe', async () => {
    const probe = vi.fn();

    await runSessionStartProbe('/workspace', probe);

    expect(probe).toHaveBeenCalledWith('/workspace');
  });

  it('swallows probe failures so startup remains fail-open', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('daemon unavailable'));

    await expect(runSessionStartProbe('/workspace', probe)).resolves.toBeUndefined();
  });
});
