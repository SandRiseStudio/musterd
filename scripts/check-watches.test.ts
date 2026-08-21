import { describe, expect, it } from 'vitest';
import { ruleA, ruleAImmutable, ruleB } from './check-watches.ts';
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

/*
 * Rule B. The load-bearing test in this block is the LAST one: an adverb in an ADR the diff did not
 * touch must pass. `check-change-adr.ts:176` records what happens when a rule like this becomes a
 * tree check — it "would fire on every PR touching one of those 94". Measured on this corpus:
 * 14 of 292 existing ADRs carry a frequency term in their Decision. That is not most of them, but
 * it is 14 failures an author cannot fix on a PR that touched none of them.
 */

const adr = (decision: string, header = '') =>
  `# 301 — A thing\n\n- Status: draft — 2026-08-21.\n${header}\n## Context\n\nThe reconnect is flaky under load, historically.\n\n## Decision\n\n${decision}\n\n## Consequences\n\nNone.\n`;

const at = (text: string) => [{ path: 'docs/decisions/301-a.md', text }];

describe('rule B — a frequency claim in a Decision needs a watch', () => {
  it('fails an unbacked frequency claim', () => {
    const errors = ruleB(at(adr('The reconnect is flaky under load, so we retry.')));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('flaky');
  });

  it('passes when a watch is cited', () => {
    expect(
      ruleB(
        at(
          adr(
            'The reconnect is flaky under load, so we retry.',
            '- Snapshot-debt: docs/watches/2026-08-21-reconnect.md\n',
          ),
        ),
      ),
    ).toEqual([]);
  });

  it('passes when the debt is explicitly waived with a reason', () => {
    expect(
      ruleB(
        at(
          adr(
            'The reconnect is flaky under load, so we retry.',
            "- Snapshot-debt: none — quoting ryder's #912 measurement\n",
          ),
        ),
      ),
    ).toEqual([]);
  });

  it('rejects a bare waiver with no reason — "none" alone is not an argument', () => {
    expect(
      ruleB(at(adr('The reconnect is flaky under load, so we retry.', '- Snapshot-debt: none\n'))),
    ).toHaveLength(1);
  });

  it('ignores the same adverb in Context — history is quoted there, not asserted', () => {
    expect(ruleB(at(adr('We retry three times.')))).toEqual([]);
  });

  it('does not fire on always/never — those are absence claims, not frequency claims', () => {
    expect(ruleB(at(adr('The guard never permits a spawn, and always logs.')))).toEqual([]);
  });

  it('matches whole words only, so "rare" does not fire inside "rarefied"', () => {
    expect(ruleB(at(adr('We compare it to rarefied alternatives.')))).toEqual([]);
  });

  it('passes an ADR with no Decision heading at all', () => {
    expect(ruleB(at('# 301 — A thing\n\n## Context\n\nflaky under load.\n'))).toEqual([]);
  });

  it('reports each offending ADR once, naming the term it found', () => {
    const errors = ruleB([
      { path: 'docs/decisions/301-a.md', text: adr('It is intermittent.') },
      { path: 'docs/decisions/302-b.md', text: adr('It usually works.') },
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('intermittent');
    expect(errors[1]).toContain('usually');
  });
});
