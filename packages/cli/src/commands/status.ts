import type { Parsed } from '../args.js';
import { renderPendingSummary, renderRoster, renderStatusHeader } from '../render/rows.js';
import { cliBuild } from '../version.js';
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
  // What's waiting for me (comeback path, ADR 024): the unanswered request_help / @me acts, read off
  // the durable inbox cursor — best-effort. Skipped for an ambient/absent identity: an inbox is
  // member-specific (and auth-gated). It rides *inside* the header now, where it outranks everything.
  const pending =
    explicit && identity
      ? await pendingActionSummary(http, team, identity.name).catch(() => undefined)
      : undefined;
  // The continuity one-liner (ADR 093 §3): the envelope read — headline + age, never the body. Seat-
  // authed and best-effort: an ambient identity, a seat with nothing saved (not_found), or any read
  // failure all stay silent. Compact here — the header has five other things to say.
  const memory =
    explicit && identity ? await http.getMemoryEnvelope(team).catch(() => undefined) : undefined;
  // Surface which daemon + db we're reading, so a wrong-db ("everyone offline") is obvious.
  const health = await http.health().catch(() => undefined);

  // `Identity` carries no kind — the roster is the authority on it, so read it back from there.
  const mine = identity ? res.members.find((m) => m.name === identity.name) : undefined;
  const me = identity ? { name: identity.name, kind: mine?.kind ?? 'agent' } : undefined;
  process.stdout.write(
    renderStatusHeader({
      team,
      server: config.server,
      health,
      members: res.members,
      me,
      pending: pending ? renderPendingSummary(pending.count, pending.since) : undefined,
      memory: memory ? renderMemoryLine(memory, Date.now(), { compact: true }) : undefined,
      cliBuild: cliBuild(),
    }) + '\n',
  );
  process.stdout.write(
    '\n' + renderRoster(res.members, undefined, undefined, health?.build) + '\n',
  );
  return 0;
}
