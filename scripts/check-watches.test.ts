import { describe, expect, it } from 'vitest';
import { ruleA, ruleAImmutable } from './check-watches.ts';
import { parseWatch, type Watch } from './watches.ts';

/*
 * Tests for the watch gate.
 *
 * Same discipline as `controls.test.ts`: the point is to prove every rule can actually fail. A gate
 * that cannot fail is worse than no gate, because it reads as protection (ADR 294's `absence`
 * class). So each rule gets both directions — the case that fires and the case that must not.
 */

/** A well-formed watch, with any field overridden. `void_if` always carries one condition. */
function watch(overrides: Record<string, string> = {}): Watch {
  const fields: Record<string, string> = {
    question: 'Does X reach zero?',
    claim_ref: 'docs/decisions/166-session-liveness-by-enumeration.md',
    falsifier: '"any instance of X is a finding"',
    population: 'workspaces with a live binding',
    series: '~/.musterd/research/adr-166-slot-sweep.jsonl',
    cadence: '5m',
    opened: '2026-08-01',
    opened_by: 'izzo',
    revisit_by: '2026-09-04',
    status: 'open',
    ...overrides,
  };
  const frontmatter = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return parseWatch(
    'docs/watches/w.md',
    `---\n${frontmatter}\nvoid_if:\n  - the population moves\n---\n\nBody.\n`,
  )!;
}

describe('rule A — no watch outlives its revisit_by', () => {
  it('passes a watch still inside its window', () => {
    expect(ruleA([watch()], '2026-09-01')).toEqual([]);
  });

  it('fails an open watch past its revisit_by', () => {
    const errors = ruleA([watch()], '2026-09-05');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('revisit_by');
  });

  it('names the opener, so a stranger who hits this knows who to ask', () => {
    expect(ruleA([watch()], '2026-09-05')[0]).toContain('izzo');
  });

  it('offers voiding as the legitimate one-line escape', () => {
    expect(ruleA([watch()], '2026-09-05')[0]).toContain('void');
  });

  it('passes the same overdue watch once it is resolved', () => {
    expect(ruleA([watch({ status: 'resolved', resolution: 'target zero breached' })], '2026-09-05')).toEqual(
      [],
    );
  });

  it('passes the same overdue watch once it is void', () => {
    expect(ruleA([watch({ status: 'void', resolution: 'unattended' })], '2026-09-05')).toEqual([]);
  });

  it('fires on the day after revisit_by, not on the day itself', () => {
    expect(ruleA([watch()], '2026-09-04')).toEqual([]);
    expect(ruleA([watch()], '2026-09-05')).toHaveLength(1);
  });
});

describe('rule A — revisit_by is immutable once merged', () => {
  it('fails when revisit_by moves forward on an existing watch', () => {
    const errors = ruleAImmutable([
      { path: 'docs/watches/w.md', head: watch({ revisit_by: '2026-10-01' }), base: watch() },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('renewed in place');
  });

  it('fails when revisit_by moves backward too — any edit is a renewal', () => {
    expect(
      ruleAImmutable([
        { path: 'docs/watches/w.md', head: watch({ revisit_by: '2026-08-25' }), base: watch() },
      ]),
    ).toHaveLength(1);
  });

  it('passes when revisit_by is unchanged', () => {
    expect(ruleAImmutable([{ path: 'docs/watches/w.md', head: watch(), base: watch() }])).toEqual([]);
  });

  it('passes a brand-new watch, which has no base to contradict', () => {
    expect(ruleAImmutable([{ path: 'docs/watches/w.md', head: watch(), base: null }])).toEqual([]);
  });
});
