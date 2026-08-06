import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  adrNumbersInPaths,
  adrNumbersInPrText,
  nextAdrNumber,
  prClaims,
} from '../scripts/adr-next.ts';

describe('nextAdrNumber (ADR 220)', () => {
  it('is one past the highest claimed number', () => {
    expect(nextAdrNumber([1, 2, 3])).toBe(4);
    expect(nextAdrNumber([219])).toBe(220);
  });

  it('starts at 001 when nothing is claimed', () => {
    expect(nextAdrNumber([])).toBe(1);
  });

  // The whole point of the tool: a number held only by an OPEN PR must still be skipped. This is
  // the 2026-08-04 collision in miniature — main's highest was 213, izzo's open PR held 214, and
  // reading main alone handed 214 out twice.
  it('skips a number claimed only by an in-flight PR', () => {
    const main = [211, 212, 213];
    const openPr = [214];
    expect(nextAdrNumber(main)).toBe(214); // the old answer — the collision
    expect(nextAdrNumber([...main, ...openPr])).toBe(215); // the fixed one
  });

  // Gaps stay unfilled: a gap usually means the number was once referenced somewhere, and reusing
  // it would silently repoint an old reference at a new decision.
  it('never fills a gap left by an abandoned or renumbered ADR', () => {
    expect(nextAdrNumber([1, 2, 5])).toBe(6);
  });

  it('ignores non-integers and negatives rather than throwing', () => {
    expect(nextAdrNumber([Number.NaN, -3, 7])).toBe(8);
  });
});

// The tool answers from `origin/main`, which is a LOCAL ref only as current as the last fetch. On
// 2026-08-04 it reported 224 free while a merged PR already held it. Importing this module must
// stay side-effect free (the suite would otherwise fetch on every run), and the CLI path must warn
// rather than answer silently when it cannot refresh.
describe('origin/main freshness', () => {
  const script = fileURLToPath(new URL('../scripts/adr-next.ts', import.meta.url));

  it('runs nothing on import — the exports are pure', () => {
    // Proven by this suite: importing at the top of this file neither fetched nor printed. Asserted
    // explicitly so a future refactor that drops the direct-invocation guard fails here.
    expect(typeof nextAdrNumber).toBe('function');
    expect(typeof adrNumbersInPaths).toBe('function');
  });

  it('warns instead of trusting a stale ref when git is unreachable', () => {
    // An empty PATH makes `git` unresolvable — the offline shape, without touching the network.
    const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    expect(res.stderr).toContain('could not fetch origin/main');
    expect(res.stderr).toContain('as old as your last fetch');
  });
});

describe('adrNumbersInPaths', () => {
  it('reads the number from any path shape, and only from ADR-shaped names', () => {
    expect(
      adrNumbersInPaths([
        'docs/decisions/210-exact-match-local-continuity.md',
        '219-quiescence-marks-a-busy-wake-candidate.md',
        'docs/decisions/README.md',
        'packages/protocol/src/residency.ts',
        'docs/perf/2026-08-04-notes.md',
      ]),
    ).toEqual([210, 219]);
  });

  it('does not mistake a four-digit prefix for an ADR number', () => {
    expect(adrNumbersInPaths(['docs/superpowers/plans/2026-08-03-standing-context.md'])).toEqual(
      [],
    );
  });
});

/**
 * ADR 223 amendment (2026-08-05). The ritual says "push the draft PR BEFORE writing the ADR" and
 * "the title should name the number" — so a compliant reservation has the number in its TITLE and
 * no `docs/decisions/` file at all. The detector read file paths only, so following the instruction
 * literally made the claim invisible. Three seats allocated 241 within an hour.
 */
describe('adrNumbersInPrText (ADR 223 amendment) — a reservation is visible before the file exists', () => {
  it('reads the number from the title shape the ritual itself specifies', () => {
    // ADR 223's Decision: "The draft PR's title should name the number (`ADR 223: <slug>`)".
    expect(adrNumbersInPrText('ADR 241: a wake verifies against its own lease', '')).toEqual([241]);
    expect(adrNumbersInPrText('ADR 241 — a wake verifies against its own lease', '')).toEqual([
      241,
    ]);
    expect(adrNumbersInPrText('adr 241 seat footprint', '')).toEqual([241]);
  });

  it('reads a number a branch name claims, for a reservation whose title forgot', () => {
    expect(adrNumbersInPrText('', 'ryder/adr-241-wake-lease')).toEqual([241]);
    expect(adrNumbersInPrText('', 'feat/adr241-seat-footprint')).toEqual([241]);
  });

  it('takes both sources at once and de-duplicates', () => {
    expect(adrNumbersInPrText('ADR 241: wake lease', 'ryder/adr-241-wake-lease')).toEqual([241]);
  });

  // The cost of reading prose: a title MENTIONING an ADR reserves it too. That is the safe
  // direction — the reserved set may only widen (ADR 220's gaps-stay-unfilled rule means an
  // over-reservation costs an integer, while an under-reservation costs a collision).
  it('over-reserves rather than under-reserves when a title merely cites an ADR', () => {
    expect(adrNumbersInPrText('fix(cli): the ADR 131 wake path defers', '')).toEqual([131]);
  });

  it('ignores numbers that are not ADR-shaped', () => {
    expect(adrNumbersInPrText('fix: bump timeout to 241 seconds', 'izzo/timeout-241')).toEqual([]);
    expect(adrNumbersInPrText('ADR 1234: not a three-digit number', '')).toEqual([]);
    expect(adrNumbersInPrText('', 'izzo/handoff-lane-note')).toEqual([]);
  });

  it('survives a missing title or branch — the fields are optional on the wire', () => {
    expect(adrNumbersInPrText(undefined, undefined)).toEqual([]);
  });
});

/**
 * The WIRING, not the matchers. The first cut of this change had every matcher test above passing
 * while the PR scan still ignored prose entirely — mutation proved it: emptying the prose read
 * killed nothing. A helper nobody calls is not a fix.
 */
describe('prClaims — what one open PR reserves, and on what evidence', () => {
  it('reads a reservation that has no ADR file at all — the case that collided', () => {
    // ryder's #703, verbatim: implementation files only, number in title and branch.
    expect(
      prClaims({
        number: 703,
        files: [{ path: 'packages/cli/src/host/wake.ts' }],
        title: 'ADR 241: a wake verifies against its own lease',
        headRefName: 'ryder/adr-241-wake-lease',
      }),
    ).toEqual([{ number: 241, reserved: true }]);
  });

  it('marks a written ADR as claimed, not reserved, even when the title names it too', () => {
    expect(
      prClaims({
        number: 706,
        files: [{ path: 'docs/decisions/243-a-handoff-carries-its-own-why.md' }],
        title: 'ADR 243 — a handoff carries its own why',
        headRefName: 'izzo/handoff-lane-note',
      }),
    ).toEqual([{ number: 243, reserved: false }]);
  });

  it('reports both when a PR carries one written ADR and reserves another', () => {
    expect(
      prClaims({
        number: 707,
        files: [{ path: 'docs/decisions/244-seat-footprint-reap.md' }],
        title: 'ADR 244 + ADR 242 follow-up',
        headRefName: 'kimi/footprint',
      }),
    ).toEqual([
      { number: 244, reserved: false },
      { number: 242, reserved: true },
    ]);
  });

  it('claims nothing from a PR that names no ADR anywhere', () => {
    expect(
      prClaims({
        number: 701,
        files: [{ path: 'packages/web/src/live/Live.css' }],
        title: 'fix(web): the review sheet gets out of the way',
        headRefName: 'miley/review-sheet',
      }),
    ).toEqual([]);
  });
});
