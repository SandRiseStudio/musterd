import type { Parsed } from '../args.js';
import { renderStatusHeader, renderStatusTable } from '../render/rows.js';
import { resolve } from './helpers.js';

export async function statusCommand(parsed: Parsed): Promise<number> {
  const { config, team, http } = resolve(parsed.flags);
  const res = await http.roster(team);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.members) + '\n');
    return 0;
  }
  // Surface which daemon + db we're reading, so a wrong-db ("everyone offline") is obvious.
  const health = await http.health().catch(() => undefined);
  process.stdout.write(renderStatusHeader(team, config.server, health) + '\n');
  process.stdout.write(renderStatusTable(res.members) + '\n');
  return 0;
}
