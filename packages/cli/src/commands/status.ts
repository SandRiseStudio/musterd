import type { Parsed } from '../args.js';
import { renderPendingSummary, renderStatusHeader, renderStatusTable } from '../render/rows.js';
import { pendingActionSummary, resolveRead } from './helpers.js';
import { renderMemoryLine } from './memory.js';

export async function statusCommand(parsed: Parsed): Promise<number> {
  // `status` is a read: it shows the (auth-free) roster anywhere, even from an unbound folder with
  // no active identity (ADR 036). The per-member comeback summary needs a genuine actor, so it only
  // runs when someone is explicitly active here.
  const { config, team, identity, explicit, http } = resolveRead(parsed.flags);
  const res = await http.roster(team);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.members) + '\n');
    return 0;
  }
  // Lead with what's waiting for me (comeback path, ADR 024): a returning/away human sees the
  // unanswered request_help / @me acts up top, read off the durable inbox cursor — best-effort.
  // Skipped for an ambient/absent identity: an inbox is member-specific (and auth-gated).
  const pending =
    explicit && identity
      ? await pendingActionSummary(http, team, identity.name).catch(() => undefined)
      : undefined;
  if (pending) {
    process.stdout.write(renderPendingSummary(pending.count, pending.since) + '\n');
  }
  // The continuity one-liner (ADR 093 §3): headline + age, never the body — same line `claim`
  // prints on occupy. Seat-authed and best-effort: an ambient identity, a seat with nothing saved
  // (not_found), or any read failure all stay silent.
  if (explicit && identity) {
    const mem = await http.getMemory(team).catch(() => undefined);
    if (mem) {
      process.stdout.write(
        renderMemoryLine({
          headline: mem.headline,
          saved_at: mem.saved_at,
          size_bytes: Buffer.byteLength(mem.body, 'utf8'),
        }) + '\n',
      );
    }
  }
  // Surface which daemon + db we're reading, so a wrong-db ("everyone offline") is obvious.
  const health = await http.health().catch(() => undefined);
  process.stdout.write(renderStatusHeader(team, config.server, health) + '\n');
  process.stdout.write(renderStatusTable(res.members) + '\n');
  return 0;
}
