import type { MemberSummary, Presence } from '@musterd/protocol';

/**
 * Whether a seat is in the room because something WOKE it (ADR 131 residency), rather than because
 * a person opened a terminal.
 *
 * The fact has been on the wire since musterd/0.2 and unread by the web the whole time.
 * `PresenceSchema.provenance` is stamped at attach (protocol/src/member.ts:64), the roster selects
 * the whole presence row (`SELECT p.*`, store/presence.ts:461) and ships it untouched
 * (transport/http.ts:1427), and `fetchRoster` parses it into memory (client.ts:122). Until now the
 * only `provenance` in this package was the literal `'session'` the client sends for itself
 * (client.ts:610) — so an eleven-second codex wake and a human at a keyboard drew identically.
 *
 * Read on the LIVE row, matching `computeData` (OfficeScene.tsx:37) and for the same reason: a seat
 * can hold a stale offline row ahead of its live one, and a nameplate that took `surface` from one
 * session and `provenance` from another would be describing two different attachments as one.
 *
 * **This never infers.** ADR 236 — absence is not an assertion. A row that carries no provenance is
 * a row that did not say; pre-0.2 sessions and older clients all land there, and none of them is
 * evidence either way. So the answer comes from the stamped value alone, and the false case means
 * "not claiming a wake" rather than "established not a wake".
 */
export function wokenSeat(m: Pick<MemberSummary, 'presences'>): boolean {
  return livePresence(m)?.provenance === 'wake';
}

/** The live row the rest of the nameplate reads — online/away first, else whatever there is. */
function livePresence(m: Pick<MemberSummary, 'presences'>): Presence | undefined {
  return (
    m.presences?.find((p) => p.status === 'online' || p.status === 'away') ?? m.presences?.[0]
  );
}

/**
 * What the surfaces are allowed to SAY about a wake, in one place so the roster chip and the
 * office nameplate cannot drift apart.
 *
 * Deliberately not "woken by <sender>", which is what the lane first asked for. The sender is on
 * the `residency.wake_leased` audit row and `GET /teams/:slug/audit` is admin-only
 * (transport/http.ts:1954), while a /live viewer holds ordinary member auth. The presence does
 * carry `wake_lease`, but a lease id is not a name — resolving it needs the same gated audit. So
 * the badge says the part it can stand behind, and its own tooltip records why it stops there.
 *
 * `woken` is NOT a fifth posture. posture.ts:7 — clients render the wire token, they do not invent
 * synonyms — and this answers a different question anyway: posture is what the seat is doing,
 * provenance is why it is here at all. A woken seat can be `working`, `active` or `away` like any
 * other, and the two facts are drawn side by side rather than one replacing the other.
 */
export function wokenBadge(): { label: string; title: string } {
  return {
    label: 'woken',
    title:
      'Spawned by a wake (ADR 131) rather than by someone opening a session. ' +
      'Who sent it is not knowable from here — that lives on the admin-only audit.',
  };
}
