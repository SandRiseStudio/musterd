import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { formatMember, formatRoster } from './format.js';

const base = { team: 'dawn', lifecycle: 'forever' as const, created_at: 0, role: '' };

const working: MemberSummary = {
  ...base,
  id: '1',
  name: 'izzo',
  kind: 'agent',
  presence: 'online',
  activity: 'working',
  state: 'Shipping ADR 131 inc 3 — the wake actuator',
  presences: [
    {
      surface: 'claude-code',
      status: 'online',
      last_seen_at: 0,
      model: 'claude-fable-5',
      workspace: 'agents-izzo@main',
    },
  ],
};
const out: MemberSummary = {
  ...base,
  id: '2',
  name: 'ryder',
  kind: 'agent',
  presence: 'offline',
  activity: 'offline',
  presences: [],
  wakeable: true,
};

describe('formatRoster (the agent-facing roster)', () => {
  it('says what each teammate is working on — the fact the old tool left out', () => {
    const text = formatRoster([working, out]);
    expect(text).toContain('Shipping ADR 131 inc 3');
    expect(text).toContain('claude-fable-5'); // attested model (ADR 101)
    expect(text).toContain('agents-izzo@main'); // where
  });

  it('groups by working / here / out and leads with the roll call', () => {
    const text = formatRoster([working, out]);
    expect(text).toContain('2 members · 1 present · 1 working');
    expect(text).toContain('working:');
    expect(text).toContain('out:');
    expect(text).not.toContain('here:'); // an empty group is not a fact
  });

  it('names the reader — an agent needs to know which seat it is', () => {
    expect(formatRoster([working], 'izzo')).toContain('you are izzo');
  });

  it('stays silent on absent facets — no `role=—`, no `lifecycle=forever`', () => {
    const text = formatRoster([working, out]);
    expect(text).not.toContain('role=');
    expect(text).not.toContain('lifecycle=');
    expect(text).not.toContain('—\n');
    expect(text).not.toContain('forever');
  });

  it('marks a residency-enrolled seat wakeable — offline is not unreachable (ADR 131)', () => {
    expect(formatRoster([out])).toContain('ryder (agent · wakeable)');
  });

  it('clips a long status in the overview, but never in the detail view', () => {
    const long = { ...working, state: 'x'.repeat(400) };
    // the roster is an overview — twenty working members must not bury the reader
    expect(formatRoster([long])).toContain('…');
    // `team_members` is the detail tool: a truncated status is useless to someone deciding to hand off
    expect(formatMember(long)).toContain('x'.repeat(400));
    expect(formatMember(long)).not.toContain('…');
  });

  it('collapses a multi-line status to one line', () => {
    const multi = { ...working, state: 'line one\n\nline two' };
    expect(formatMember(multi)).toContain('line one line two');
  });

  it('handles an empty team', () => {
    expect(formatRoster([])).toBe('no members');
  });
});
