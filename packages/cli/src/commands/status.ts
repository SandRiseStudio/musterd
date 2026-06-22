import type { Parsed } from '../args.js';
import { renderPendingSummary, renderStatusHeader, renderStatusTable } from '../render/rows.js';
import { pendingActionSummary, resolve } from './helpers.js';

export async function statusCommand(parsed: Parsed): Promise<number> {
  const { config, team, identity, http } = resolve(parsed.flags);
  const res = await http.roster(team);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.members) + '\n');
    return 0;
  }
  // Lead with what's waiting for me (comeback path, ADR 024): a returning/away human sees the
  // unanswered request_help / @me acts up top, read off the durable inbox cursor — best-effort.
  const pending = await pendingActionSummary(http, team, identity.name).catch(() => undefined);
  if (pending) {
    process.stdout.write(renderPendingSummary(pending.count, pending.since) + '\n');
  }
  // Surface which daemon + db we're reading, so a wrong-db ("everyone offline") is obvious.
  const health = await http.health().catch(() => undefined);
  process.stdout.write(renderStatusHeader(team, config.server, health) + '\n');
  process.stdout.write(renderStatusTable(res.members) + '\n');
  return 0;
}
