import { type Binding, type Surface } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig, rememberIdentity, saveBinding, saveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

/**
 * `musterd join <slug> --as <name>` — occupy the named seat via the v0.3 claim handshake (ADR 075),
 * authenticated by the team agent key (or a human credential). Stores the resolved identity in the
 * vault (ADR 059) and binds this folder so acts work here without `--as` (ADR 036). The v0.2
 * `--token` per-seat credential is gone; the authenticator is `--key` (`MUSTERD_AGENT_KEY` / a cached
 * key) and an optional `--grant` skips the approval lane.
 */
export async function joinCommand(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[0];
  const name = flagStr(parsed.flags, 'as');
  if (!slug || !name) {
    throw new CliError(
      'usage: musterd join <slug> --as <name> [--key <mskey_|mscr_>] [--grant <msgr_>] [--surface cli]',
      2,
    );
  }
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const surface = (flagStr(parsed.flags, 'surface') ?? 'cli') as Surface;

  // v0.3: authenticate the claim with the team agent key (or a credential). Resolve it from --key /
  // MUSTERD_AGENT_KEY / a previously-cached key for this member (ADR 059).
  const cached = config.knownIdentities.find((i) => i.team === slug && i.name === name);
  const key = flagStr(parsed.flags, 'key') ?? process.env['MUSTERD_AGENT_KEY'] ?? cached?.key;
  if (!key) {
    throw new CliError(
      `no key for "${name}" on "${slug}" — pass --key <mskey_|mscr_> (the team agent key, or your credential)`,
      4,
    );
  }
  const grant = flagStr(parsed.flags, 'grant') ?? process.env['MUSTERD_GRANT'];

  const http = new HttpClient({ server, surface });
  const outcome = await http.claim(slug, {
    key,
    target: { seat: name },
    surface,
    ...(grant !== undefined ? { grant } : {}),
  });
  if (outcome.state === 'refused') {
    const tail = outcome.hint ? ` — ${outcome.hint}` : '';
    throw new CliError(`join refused (${outcome.code}): ${outcome.message}${tail}`, 4);
  }
  if (outcome.state === 'pending') {
    process.stdout.write(
      `${theme.meta('⧖')} ${outcome.message} (request ${outcome.requestId}) — approve to go online\n`,
    );
    return 0;
  }
  const seat = outcome.seat.name;

  config.server = server;
  config.current = slug;
  config.identities[slug] = { name: seat, key, surface };
  rememberIdentity(config, { team: slug, name: seat, key, surface }); // ADR 059 vault
  saveConfig(config);
  // Auto-bind the joining folder so it's immediately *active* here (ADR 036).
  const binding: Binding = {
    server,
    team: slug,
    agent_key: key,
    surface: surface as Binding['surface'],
    claim: { mode: 'seat', name: seat },
    ...(grant !== undefined ? { grant } : {}),
  };
  saveBinding(process.cwd(), binding);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: slug, member: seat, surface }) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.ok('✓')} ${seat} joined ${slug}\n`);
  process.stdout.write(`${theme.presenceDot('online')} ${seat} online via ${surface}\n`);
  return 0;
}
