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

describe('the channel rule', () => {
  // Lane 01M2RP18EV. The old text read: "Use one channel only: with the `team_*` tools, do not
  // also drive the CLI (it resolves to a different identity and your sends fail)." That is false
  // on a wired Workspace — `musterd whoami` in a seat worktree reports the same seat the MCP tools
  // join, because both read the SAME `.musterd/binding.json` ("cli · binding"). MUSTERD_MEMBER was
  // retired by ADR 075 and nothing in packages/ reads it, so a registration cannot bake a second
  // identity any more. The real hazard is the working directory, which the old rule never named.
  it('does not forbid the CLI outright, because the orient skill prescribes a CLI command', () => {
    const primer = renderRepositoryPrimer({ team: 'dawn' });

    expect(primer).not.toContain('Use one channel only');
    expect(primer).not.toContain('do not also drive the CLI');
  });

  it('warns about the working directory, which is what actually swaps identity', () => {
    const primer = renderRepositoryPrimer({ team: 'dawn' });

    // The falsifiable fact: the CLI resolves a seat from the cwd's binding, so running it from a
    // teammate's worktree sends AS that teammate — a real defect the old wording could not catch.
    expect(primer).toContain('from this Workspace');
    expect(primer).toContain('musterd whoami');
  });

  it('tells a seat the CLI is correct where no tool exists, naming a case that exists today', () => {
    const primer = renderRuntimePrimer({ team: 'dawn', member: 'Ada' });

    expect(primer).toContain('session orient-stamp');
  });
});
