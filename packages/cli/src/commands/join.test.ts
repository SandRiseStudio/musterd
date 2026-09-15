import { readFileSync } from 'node:fs';
import { FEATURE_EPOCH } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { CliError } from '../errors.js';
import { joinAliasNotice, joinArgvToClaim } from './join.js';

describe('`musterd join` is an argv translation onto `claim` (ADR 377 increment 1)', () => {
  it('maps `<slug> --as <name>` to `<name> --team <slug> --detach` and passes every other flag through', () => {
    const out = joinArgvToClaim(
      parseArgs([
        'revive',
        '--as',
        'ryder',
        '--key',
        'mskey_x',
        '--grant',
        'msgr_y',
        '--surface',
        'cli',
        '--json',
      ]),
    );
    expect(out.positionals).toEqual(['ryder']);
    expect(out.flags).toEqual({
      team: 'revive',
      detach: true,
      key: 'mskey_x',
      grant: 'msgr_y',
      surface: 'cli',
      json: true,
    });
    expect(out.flags).not.toHaveProperty('as');
  });

  it('the notice names the claim spelling for exactly these arguments', () => {
    const out = joinArgvToClaim(parseArgs(['revive', '--as', 'ryder']));
    expect(joinAliasNotice(out)).toBe(
      'musterd join is now: musterd claim ryder --team revive --detach (ADR 377) — this spelling stays one epoch',
    );
  });

  it('refuses a missing slug or --as with the usage line that also shows the new spelling (exit 2)', () => {
    for (const argv of [[], ['revive'], ['--as', 'ryder']]) {
      let err: unknown;
      try {
        joinArgvToClaim(parseArgs(argv));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).message).toContain('musterd claim <name> --team <slug>');
    }
  });
});

/**
 * ADR 377, "Retirement of the `join` alias": *one FEATURE_EPOCH after increment 1 lands, remove the
 * dispatch case, the way #1253 removed `lane_ready`.* Nothing enforced that. Increment 1 landed at
 * `0d54c2f5` on 2026-09-03 and the epoch was set to 19 the same day by `team_availability`
 * (`acb367a4`), so the clock has not moved and the alias is correctly still here — but the retirement
 * was a sentence in an ADR that only fires if a human remembers it while bumping an unrelated
 * constant (2026-09-05; falsify: `git log -S "FEATURE_EPOCH = 19"` — if the epoch has moved past 19
 * and this test still passes with `case 'join'` present in `bin.ts`, the guard is broken, not the code).
 *
 * So the deadline enforces itself: the next epoch bump fails here until the alias goes. This asserts
 * on the source text of the dispatch table because the switch in `bin.ts` cannot be introspected at
 * runtime — a weaker instrument than exercising it, and the reason the assertion is paired with the
 * behavioural tests above rather than standing alone.
 */
describe('the `join` alias retires on schedule (ADR 377)', () => {
  const binSource = readFileSync(new URL('../bin.ts', import.meta.url), 'utf8');
  const ALIAS_LANDED_AT_EPOCH = 19;

  it(`is still dispatchable at epoch ${ALIAS_LANDED_AT_EPOCH}, and must be gone at ${ALIAS_LANDED_AT_EPOCH + 1}`, () => {
    if (FEATURE_EPOCH <= ALIAS_LANDED_AT_EPOCH) {
      // Not vacuous today: the alias must be PRESENT, so this fails if someone deletes it early and
      // silently breaks the pasted `musterd join` lines it exists to keep working.
      expect(binSource).toContain("case 'join':");
      return;
    }
    expect(
      binSource.includes("case 'join':"),
      `FEATURE_EPOCH is ${FEATURE_EPOCH}; ADR 377 retires the \`join\` alias one epoch after ${ALIAS_LANDED_AT_EPOCH}. ` +
        'Remove the dispatch case in bin.ts, delete commands/join.ts and this file, and drop the alias note from the catalog.',
    ).toBe(false);
  });
});
