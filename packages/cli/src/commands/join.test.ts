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
