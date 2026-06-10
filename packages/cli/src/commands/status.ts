import type { Parsed } from '../args.js';
import { renderStatusTable } from '../render/rows.js';
import { resolve } from './helpers.js';

export async function statusCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const res = await http.roster(team);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.members) + '\n');
    return 0;
  }
  process.stdout.write(renderStatusTable(res.members) + '\n');
  return 0;
}
