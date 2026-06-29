import type { Parsed } from '../args.js';
import { theme } from '../render/theme.js';
import { resolveRead } from './helpers.js';

/**
 * `musterd whoami` (ADR 067) — print the identity this folder resolves to right now, and where it
 * came from. The first thing a fresh agent reaches for to confirm which seat it's acting as before it
 * sends; without it, the only way to check was to read a binding file by hand. Read-only and
 * identity-optional (ADR 036): an unbound folder is a valid answer, not an error — it prints how to
 * claim a seat instead. The `source` makes the precedence legible (env > binding > --as > config),
 * and flags the ambient config case, which can read but never act.
 */
export async function whoamiCommand(parsed: Parsed): Promise<number> {
  const { team, identity, identitySource, explicit } = resolveRead(parsed.flags);

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        team,
        member: identity?.name ?? null,
        surface: identity?.surface ?? null,
        source: identitySource ?? null,
        explicit,
      }) + '\n',
    );
    return 0;
  }

  if (!identity) {
    process.stdout.write(
      `${theme.meta('not bound')} on team ${theme.accent(team)} — claim a seat: ${theme.accent('musterd claim <name>')}\n`,
    );
    return 0;
  }

  // The ambient global-config identity can read but never act (ADR 036) — say so, so a "send refused"
  // later isn't a surprise.
  const note = explicit
    ? ''
    : theme.meta('  (read-only — global config; claim or use --as to act)');
  process.stdout.write(
    `${theme.accent(identity.name)} on ${theme.accent(team)} ` +
      theme.meta(`(${identity.surface} · ${identitySource})`) +
      note +
      '\n',
  );
  return 0;
}
