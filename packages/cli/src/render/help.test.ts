import { describe, expect, it } from 'vitest';
import { GROUPS, START_HERE } from '../help/catalog.js';
import {
  nearestCommand,
  renderCommandHelp,
  renderGroupHelp,
  renderHelp,
  renderHelpJson,
} from './help.js';

// Color is pinned OFF via NO_COLOR in vitest.config, so assertions are on visible text.

describe('renderHelp (grouped overview)', () => {
  const out = renderHelp();

  it('leads with the banner tagline and a start-here section', () => {
    expect(out).toContain('persistent teams');
    expect(out.toLowerCase()).toContain('start here');
  });

  it('shows every group title', () => {
    for (const g of GROUPS) expect(out.toUpperCase()).toContain(g.title.toUpperCase());
  });

  it('surfaces the start-here commands and points at deeper help', () => {
    for (const n of START_HERE) expect(out).toContain(n);
    expect(out).toContain('musterd help <command>');
    expect(out).toContain('musterd help --json');
  });

  it('folds non-primary commands behind a "+N more" pointer by default', () => {
    expect(out).toContain('more — musterd help setup');
    // `wire` is non-primary in setup, so it is hidden from the condensed overview…
    expect(renderHelp().includes('\nwire')).toBe(false);
    // …but --full inlines it.
    expect(renderHelp({ full: true })).toContain('wire');
  });
});

describe('renderCommandHelp', () => {
  it('shows signature, summary, detail, and examples for a known command', () => {
    const out = renderCommandHelp('lane')!;
    expect(out).toContain('musterd lane');
    expect(out).toContain('declare a unit of work');
    expect(out.toLowerCase()).toContain('examples');
    expect(out).toContain('musterd lane open');
  });

  it('returns null for an unknown command', () => {
    expect(renderCommandHelp('bogus')).toBeNull();
  });
});

describe('renderGroupHelp', () => {
  it('lists a whole group, including non-primary commands', () => {
    const out = renderGroupHelp('setup')!;
    expect(out).toContain('wire');
    expect(out).toContain('uninstall');
  });

  it('returns null for an unknown group id', () => {
    expect(renderGroupHelp('nope')).toBeNull();
  });
});

describe('renderHelpJson', () => {
  it('round-trips the catalog with stable top-level keys', () => {
    const j = JSON.parse(renderHelpJson());
    expect(j.groups.length).toBe(GROUPS.length);
    expect(j.commands.length).toBeGreaterThan(20);
    expect(j.start_here).toEqual([...START_HERE]);
    expect(Array.isArray(j.acts)).toBe(true);
  });
});

describe('nearestCommand', () => {
  it('suggests the closest command for a typo', () => {
    expect(nearestCommand('clam')).toBe('claim');
    expect(nearestCommand('statuss')).toBe('status');
  });

  it('returns null when nothing is close', () => {
    expect(nearestCommand('xyzzy-nonsense')).toBeNull();
  });
});
