import { describe, expect, it } from 'vitest';
import { decisionSection, isAppendOnlyAmendment } from './adr-sections.ts';

/*
 * Extracted from `check-change-adr.ts` so a second gate can share it — the same move, for the same
 * stated reason, as `adr-status.ts`: that file reads git and calls `process.exit` at the top level,
 * so importing it runs the gate instead of using it.
 *
 * These tests did not exist while the function was private. They exist now because two gates depend
 * on its exact boundaries: `check-change-adr` freezes what it returns, and `check-watches` scans it
 * for frequency claims. If those two ever disagreed about where a Decision starts and stops, one of
 * them would be silently wrong.
 */

const ADR = `# 301 — A thing

- Status: draft — 2026-08-21.

## Context

The reconnect is flaky under load, historically.

## Decision

We retry three times.

## Consequences

None.
`;

describe('decisionSection', () => {
  it('returns the Decision body', () => {
    expect(decisionSection(ADR)).toBe('We retry three times.');
  });

  it('stops at the next heading, so Consequences is not swept in', () => {
    expect(decisionSection(ADR)).not.toContain('None.');
  });

  it('excludes Context, where history is quoted rather than asserted', () => {
    expect(decisionSection(ADR)).not.toContain('flaky');
  });

  it('returns null when there is no Decision heading', () => {
    expect(decisionSection('# 301 — A thing\n\n## Context\n\nWords.\n')).toBeNull();
  });

  it('runs to the end of the file when Decision is the last section', () => {
    expect(decisionSection('# 301\n\n## Decision\n\nThe last word.\n')).toBe('The last word.');
  });

  it('matches the heading case-insensitively, as the corpus is not uniform', () => {
    expect(decisionSection('# 301\n\n## decision\n\nLowercase heading.\n')).toBe(
      'Lowercase heading.',
    );
  });
});

/*
 * Append-only amendment markers (2026-08-31, dolly's REQUIRED 1 on #1087).
 *
 * The repo has a convention for marking superseded Decision text where a reader will actually meet
 * it — ADR 160:48 and :90, ADR 250:67 — and `change-adr:check` could not express it: it freezes the
 * whole `## Decision`, and its only escape (`wasEverOnMain`) is a restoration check that by
 * construction cannot pass new text. Those precedents landed while the gate's status regex was
 * blind (lane 01KZAKS6D3), so the convention and the gate contradicted each other and the gate won.
 * Measured: writing dolly's requested markers into ADR 326 failed the gate.
 *
 * The allowance has to be narrow enough not to reopen the hole the gate closed. It is: the prior
 * Decision must survive word for word, and the only permitted addition is a dated marker. Strip the
 * markers; if what remains matches, the edit added a pointer and changed no decision.
 */
describe('amendment markers (append-only)', () => {
  const before = [
    '1. **The ritual.** Handle tier 1, then surface tier 2 without acting.',
    '2. **Wakes stay scoped.** A woken session gets its errand.',
  ].join('\n');

  it('accepts a dated italic marker added as its own line', () => {
    const after = [
      '1. **The ritual.** Handle tier 1, then surface tier 2 without acting.',
      '   _(Amended 2026-08-27: owed reviews are tier 1. See the amendment below.)_',
      '2. **Wakes stay scoped.** A woken session gets its errand.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(true);
  });

  it('accepts the blockquote marker form ADR 160 uses', () => {
    const after = [
      '1. **The ritual.** Handle tier 1, then surface tier 2 without acting.',
      '> **Amended 2026-08-27.** The first invariant was too broad.',
      '2. **Wakes stay scoped.** A woken session gets its errand.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(true);
  });

  it('accepts a multi-line marker block', () => {
    const after = [
      '1. **The ritual.** Handle tier 1, then surface tier 2 without acting.',
      '   _(Amended 2026-08-27: owed reviews are tier 1 — anything addressed to the seat is',
      '   taken up unprompted, and tier 2 is only unaddressed work.)_',
      '2. **Wakes stay scoped.** A woken session gets its errand.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(true);
  });

  it('REFUSES an edit to the decision text itself, marker or no marker', () => {
    const reworded = [
      '1. **The ritual.** Handle tier 1, then handle tier 2 as well.',
      '   _(Amended 2026-08-27: owed reviews are tier 1.)_',
      '2. **Wakes stay scoped.** A woken session gets its errand.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, reworded)).toBe(false);
  });

  it('REFUSES a deletion hidden behind a marker', () => {
    const deleted = [
      '1. **The ritual.** Handle tier 1, then surface tier 2 without acting.',
      '   _(Amended 2026-08-27: decision 2 is withdrawn.)_',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, deleted)).toBe(false);
  });

  it('REFUSES an undated marker — the date is what makes it a record', () => {
    const undated = [
      '1. **The ritual.** Handle tier 1, then surface tier 2 without acting.',
      '   _(Amended: owed reviews are tier 1.)_',
      '2. **Wakes stay scoped.** A woken session gets its errand.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, undated)).toBe(false);
  });

  it('REFUSES ordinary new prose that is not a marker', () => {
    const prose = [
      '1. **The ritual.** Handle tier 1, then surface tier 2 without acting.',
      '   Also, seats should probably take reviews they are sent.',
      '2. **Wakes stay scoped.** A woken session gets its errand.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, prose)).toBe(false);
  });

  it('is false when nothing was added — an unchanged Decision is not an amendment', () => {
    expect(isAppendOnlyAmendment(before, before)).toBe(false);
  });

  it('REFUSES unquoted prose written under a blockquote marker', () => {
    // A loose definition of "continuation" is how this allowance would become the escape hatch it
    // is not: anything stripped is never compared, so anything strippable is unreviewed text.
    const after = [
      '1. **The ritual.** Handle tier 1, then surface tier 2 without acting.',
      '> **Amended 2026-08-27.** Tier 2 is now unaddressed work only.',
      '   And while we are here, seats may also claim any open lane.',
      '2. **Wakes stay scoped.** A woken session gets its errand.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(false);
  });

  it('REFUSES prose written after a closed italic marker', () => {
    const after = [
      '1. **The ritual.** Handle tier 1, then surface tier 2 without acting.',
      '   _(Amended 2026-08-27: owed reviews are tier 1.)_',
      '   Seats may also claim any open lane.',
      '2. **Wakes stay scoped.** A woken session gets its errand.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(false);
  });
});

/*
 * The real case this was built for, kept as a regression fixture: ADR 326's Decision 2, and the two
 * markers dolly asked for in review of #1087. Both are MID-SENTENCE — the first lands between
 * "…`musterd session orient-stamp`." and "The stamp is workspace-local", which is inside a line and
 * not between two. A line-based strip could not see it; that is why the comparison is on words.
 */
describe('ADR 326 Decision 2 — the case this allowance was built for', () => {
  const before = [
    '2. **The orient ritual (acted, nudged until stamped).** A `musterd-orient` skill: inbox check',
    '   (the autojoin moment), memory read, **handle tier 1 unprompted** — directed asks awaiting this',
    "   seat's reply, open incident lanes — then **surface tier 2** (owed reviews, carried lanes,",
    '   up-next) without acting, one status_update, then `musterd session orient-stamp`. The stamp is',
    '   workspace-local and keyed by the captured session id.',
  ].join('\n');

  it('accepts the two markers as written', () => {
    const after = [
      '2. **The orient ritual (acted, nudged until stamped).** A `musterd-orient` skill: inbox check',
      '   (the autojoin moment), memory read, **handle tier 1 unprompted** — directed asks awaiting this',
      "   seat's reply, open incident lanes — then **surface tier 2** (owed reviews, carried lanes,",
      '   up-next) without acting, one status_update, then `musterd session orient-stamp`.',
      '   _(Amended 2026-08-27: owed reviews are **tier 1** — anything addressed to the seat is taken up',
      '   unprompted, and tier 2 is only unaddressed work. See the amendment below.)_ The stamp is',
      '   workspace-local and keyed by the captured session id.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(true);
  });

  it('still REFUSES a single changed word alongside a valid marker', () => {
    const after = [
      '2. **The orient ritual (acted, nudged until stamped).** A `musterd-orient` skill: inbox check',
      '   (the autojoin moment), memory read, **handle tier 1 unprompted** — directed asks awaiting this',
      "   seat's reply, open incident lanes — then **handle tier 2** (owed reviews, carried lanes,",
      '   up-next) without acting, one status_update, then `musterd session orient-stamp`.',
      '   _(Amended 2026-08-27: owed reviews are **tier 1**. See the amendment below.)_ The stamp is',
      '   workspace-local and keyed by the captured session id.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(false);
  });

  it('REFUSES a bare re-wrap with no marker — the relaxation rides on the marker, never alone', () => {
    const rewrapped = before.replace(/\n\s+/g, ' ');
    expect(isAppendOnlyAmendment(before, rewrapped)).toBe(false);
  });
});

/*
 * Fenced code inside a Decision (dolly's residual on #1117, 2026-08-31). She raised it, declined to
 * make it a REQUIRED under wanderer's fresh reviewer charter, and left it conditional on whether
 * such Decisions exist. Measured before taking it: 22 of 329 ADR Decisions carry a fenced block, so
 * the condition holds.
 *
 * Inside a fence, whitespace IS semantic — indentation is the code — so the word-level comparison
 * that makes mid-sentence markers possible would wave through an indent change riding a marker.
 * Comparison is therefore line-exact inside fences and word-level outside.
 */
describe('fenced code in a Decision is compared exactly', () => {
  const before = [
    '1. **The shape.** The manifest is written as:',
    '',
    '```json',
    '{',
    '  "version": 3,',
    '  "desired": ["claude-code"]',
    '}',
    '```',
    '',
    'and read back on every provision.',
  ].join('\n');

  it('accepts a marker added outside the fence', () => {
    const after = [
      '1. **The shape.** The manifest is written as:',
      '   _(Amended 2026-08-31: version 4 supersedes this shape. See the amendment below.)_',
      '',
      '```json',
      '{',
      '  "version": 3,',
      '  "desired": ["claude-code"]',
      '}',
      '```',
      '',
      'and read back on every provision.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(true);
  });

  it('REFUSES an indentation change inside the fence, even with a valid marker', () => {
    const after = [
      '1. **The shape.** The manifest is written as:',
      '   _(Amended 2026-08-31: version 4 supersedes this shape.)_',
      '',
      '```json',
      '{',
      '    "version": 3,',
      '    "desired": ["claude-code"]',
      '}',
      '```',
      '',
      'and read back on every provision.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(false);
  });

  it('REFUSES a changed value inside the fence', () => {
    const after = before.replace('"version": 3', '"version": 4') + '\n_(Amended 2026-08-31: bumped.)_';
    expect(isAppendOnlyAmendment(before, after)).toBe(false);
  });

  it('REFUSES a line added inside the fence', () => {
    const after = [
      '1. **The shape.** The manifest is written as:',
      '   _(Amended 2026-08-31: a field was added.)_',
      '',
      '```json',
      '{',
      '  "version": 3,',
      '  "toolkit": "",',
      '  "desired": ["claude-code"]',
      '}',
      '```',
      '',
      'and read back on every provision.',
    ].join('\n');
    expect(isAppendOnlyAmendment(before, after)).toBe(false);
  });

  it('does not treat marker-shaped text inside a fence as a marker', () => {
    // A fence can contain anything, including an example of a marker. Stripping it there would
    // delete code from the comparison — the swallow hole again, one level down.
    const after = before.replace('```json', '```json\n// _(Amended 2026-08-31: sample.)_');
    expect(isAppendOnlyAmendment(before, after)).toBe(false);
  });
});
