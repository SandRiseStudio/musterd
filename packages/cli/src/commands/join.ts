import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { claimCommand } from './claim.js';

/**
 * `musterd join <slug> --as <name>` — HIDDEN ALIAS since 2026-09-03 (ADR 377 increment 1). It is
 * `musterd claim <name> --team <slug> --detach [--key …] [--grant …] [--surface …]` spelled the old
 * way, and that is all it is: this file translates argv and calls `claimCommand`. `--detach` because
 * join always ran the one-shot HTTP claim whose Presence outlives the process; a pasted `join` line
 * keeps doing exactly what it did. There is one handshake
 * implementation, in `claim.ts`; the alias cannot drift from it because it has no behaviour of its own.
 * Kept dispatchable for one FEATURE_EPOCH so pasted lines keep working; prints the new spelling on
 * stderr. Retire per ADR 377 "Retirement of the `join` alias".
 */
export async function joinCommand(parsed: Parsed): Promise<number> {
  const translated = joinArgvToClaim(parsed);
  if (!parsed.flags['json']) {
    process.stderr.write(theme.meta(joinAliasNotice(translated)) + '\n');
  }
  return claimCommand(translated);
}

/** The one-line migration notice the alias prints on stderr (not under --json). */
export function joinAliasNotice(claimArgs: Parsed): string {
  const name = claimArgs.positionals[0];
  const team = flagStr(claimArgs.flags, 'team');
  return `musterd join is now: musterd claim ${name} --team ${team} --detach (ADR 377) — this spelling stays one epoch`;
}

/**
 * `join <slug> --as <name> [flags]` → `claim <name> --team <slug> --detach [flags]`. Every other flag
 * (`--key`, `--grant`, `--surface`, `--server`, `--json`, …) passes through untouched: claim already
 * reads each of them. Pure, so the mapping is unit-testable without a server.
 */
export function joinArgvToClaim(parsed: Parsed): Parsed {
  const slug = parsed.positionals[0];
  const name = flagStr(parsed.flags, 'as');
  if (!slug || !name) {
    throw new CliError(
      'usage: musterd join <slug> --as <name> [--key <mskey_|mscr_>] [--grant <msgr_>] [--surface cli]' +
        ' — or the current spelling: musterd claim <name> --team <slug>',
      2,
    );
  }
  const { as: _as, ...rest } = parsed.flags;
  return {
    positionals: [name, ...parsed.positionals.slice(1)],
    flags: { ...rest, team: slug, detach: true },
    metaPairs: parsed.metaPairs,
  };
}
