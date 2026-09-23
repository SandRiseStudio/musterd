import type { Parsed } from '../args.js';
import { theme } from '../render/theme.js';
import { resolveRead } from './helpers.js';

/**
 * `musterd whoami` (ADR 067) — print the identity this folder resolves to right now, and where it
 * came from. The first thing a fresh agent reaches for to confirm which seat it's acting as before it
 * sends; without it, the only way to check was to read a binding file by hand. Read-only and
 * identity-optional (ADR 036): an unbound folder is a valid answer, not an error — it prints how to
 * claim a seat instead. The `source` makes the precedence legible (env > binding). There is no
 * ambient case any more: a folder acts only as the member it is bound to (ADR 442).
 */
export async function whoamiCommand(parsed: Parsed): Promise<number> {
  const { team, identity, identitySource, explicit } = resolveRead(parsed.flags, {
    claimSeatPerRequest: true,
  });

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
      `${theme.meta('not bound')} on team ${theme.accent(team)} — this folder acts as nobody; ` +
        `claim a seat: ${theme.accent('musterd claim <name>')}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `${theme.accent(identity.name)} on ${theme.accent(team)} ` +
      theme.meta(`(${identity.surface} · ${identitySource})`) +
      '\n',
  );
  return 0;
}
