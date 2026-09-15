import { describe, expect, it } from 'vitest';
import {
  PRIMER_END_MARKER,
  PRIMER_START_PREFIX,
  renderRepositoryPrimer,
  renderRuntimePrimer,
} from './primer.js';

describe('renderRepositoryPrimer', () => {
  it('renders byte-identical repository context for different Workspace Members', () => {
    const adaBinding = { team: 'dawn', member: 'Ada', role: 'backend' };
    const linBinding = { team: 'dawn', member: 'Lin', role: 'reviewer' };

    const ada = renderRepositoryPrimer({ team: adaBinding.team });
    const lin = renderRepositoryPrimer({ team: linBinding.team });

    expect(ada).toBe(lin);
    expect(ada).toContain('**dawn** Team');
    expect(ada).toContain('musterd whoami');
    for (const localFact of [
      'Ada',
      'Lin',
      'backend',
      'reviewer',
      'own the data layer',
      'supabase',
    ]) {
      expect(ada).not.toContain(localFact);
    }
  });

  it('wraps the shared working loop in managed markers', () => {
    const primer = renderRepositoryPrimer({ team: 'dawn' });

    expect(primer).toContain(PRIMER_START_PREFIX);
    expect(primer).toContain(PRIMER_END_MARKER);
    expect(primer).toContain('team_inbox_check');
    expect(primer).toContain('musterd inbox');
    expect(primer).toContain('team_send');
    expect(primer).toContain('musterd send --act');
    expect(primer).toContain('status_update');
    expect(primer).toContain('working');
  });
});

describe('renderRuntimePrimer', () => {
  it('names a locally resolved Member target without a Role or charter', () => {
    const primer = renderRuntimePrimer({ team: 'dawn', member: 'Ada' });

    expect(primer).toContain('**Ada** on the **dawn** Team');
    expect(primer).not.toContain('## Your charter');
    expect(primer).not.toContain('backend');
    expect(primer).not.toContain('own the data layer');
  });

  it('keeps the unresolved claim-first orientation', () => {
    const primer = renderRuntimePrimer({ team: 'alpha' });

    expect(primer).toContain('claim your seat first');
    expect(primer).toContain('musterd claim');
    expect(primer).not.toContain('You are **');
  });
});
