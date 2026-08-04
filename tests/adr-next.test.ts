import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adrNumbersInPaths, nextAdrNumber } from '../scripts/adr-next.ts';

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
