import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig, saveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

/** Register a presence for an existing member and store the identity locally. */
export async function joinCommand(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[0];
  const name = flagStr(parsed.flags, 'as');
  if (!slug || !name) {
    throw new CliError('usage: musterd join <slug> --as <name> [--token <tok>] [--surface cli]', 2);
  }
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const surface = flagStr(parsed.flags, 'surface') ?? 'cli';
  const token = flagStr(parsed.flags, 'token') ?? config.identities[slug]?.token;
  if (!token) throw new CliError(`no token for "${name}" — pass --token <tok>`, 4);

  const http = new HttpClient({ server, token });
  await http.presence(slug, surface);

  config.server = server;
  config.current = slug;
  config.identities[slug] = { name, token, surface };
  saveConfig(config);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: slug, member: name, surface }) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.ok('✓')} ${name} joined ${slug}\n`);
  process.stdout.write(`${theme.presenceDot('online')} ${name} online via ${surface}\n`);
  return 0;
}
