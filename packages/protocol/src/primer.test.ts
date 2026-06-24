import { describe, expect, it } from 'vitest';
import { PRIMER_END_MARKER, PRIMER_START_PREFIX, renderPrimer } from './primer.js';

describe('renderPrimer', () => {
  it('names the seat (with the role clause only when present) and wraps in markers', () => {
    const withRole = renderPrimer({ member: 'Ada', team: 'dawn', role: 'backend' });
    expect(withRole).toContain('**Ada**, the backend, on the **dawn** team');
    expect(withRole).toContain(PRIMER_START_PREFIX);
    expect(withRole).toContain(PRIMER_END_MARKER);

    const noRole = renderPrimer({ member: 'Lin', team: 'dawn', role: '   ' });
    expect(noRole).toContain('**Lin** on the **dawn** team');
    expect(noRole).not.toContain(', the ');
  });

  it('tells an unprovisioned agent to claim a seat first (no fixed identity line)', () => {
    const unprovisioned = renderPrimer({ team: 'alpha' });
    expect(unprovisioned).toContain('claim your seat first');
    expect(unprovisioned).toContain('musterd claim');
    expect(unprovisioned).not.toContain('You are **');
  });

  it('is channel-aware: documents the team_* tools AND the musterd CLI', () => {
    const p = renderPrimer({ member: 'Ada', team: 'dawn' });
    expect(p).toContain('team_inbox_check');
    expect(p).toContain('musterd inbox');
    expect(p).toContain('team_send');
    expect(p).toContain('musterd send --act');
    // status reporting flips the roster to working
    expect(p).toContain('status_update');
    expect(p).toContain('working');
  });

  it('injects a role charter as its own sub-section when provided', () => {
    const p = renderPrimer({
      member: 'Ada',
      team: 'dawn',
      role: 'backend',
      charter: 'own the data layer',
    });
    expect(p).toContain('## Your charter (backend)');
    expect(p).toContain('own the data layer');
  });
});
