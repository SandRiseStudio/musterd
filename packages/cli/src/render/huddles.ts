import type { HuddleView } from '@musterd/protocol';

/**
 * How far back a room view reads. A huddle is a bounded burst, so the recent window holds it; a
 * huddle older than this is history and belongs to whatever reads history (the wiki page it landed
 * on). Named rather than inlined so the bound is arguable instead of accidental — and shared, so
 * the roster mark and `huddle list` can never disagree about which rooms are still rooms.
 */
export const TIMELINE_WINDOW = 1000;

/**
 * Who is in a room, as the roster needs to say it (ADR 378).
 *
 * A huddle is invisible on `musterd status`: a seat in one looks like any other busy seat, so the
 * gathering — the thing the team most wants to see — is the one thing the roll call cannot report.
 * This is the join that fixes that, and it is deliberately thin: `deriveHuddles` has already done
 * the reading of the wire (it is shared in `@musterd/protocol` for exactly this reason), so all
 * that is left is to turn its huddle-major answer into the seat-major one a roster row asks.
 *
 * SPOKEN, NOT NAMED. A named seat that has not turned up is not in the room — being invited is not
 * being there, and marking the invited would report a gathering that is not happening. `spoke`
 * already includes the opener, who has spoken by opening.
 *
 * OPEN ONLY. A closed huddle is history; the mark goes when the `resolve` lands, which is what
 * makes the roster line a picture of NOW rather than of everything that ever happened.
 *
 * NEWEST NAMED, THE REST COUNTED. A roster row has one line's worth of room. `deriveHuddles`
 * returns newest-first, so the first open huddle a seat appears in is the one it is most likely to
 * be in right now; the others become `+n` rather than a list nobody can read at a glance.
 */
export function huddleMarks(huddles: HuddleView[]): Map<string, string> {
  const seats = new Map<string, { topic: string; more: number }>();
  for (const h of huddles) {
    if (h.closed) continue;
    for (const who of h.spoke) {
      const seat = seats.get(who);
      if (seat) seat.more += 1;
      else seats.set(who, { topic: h.topic, more: 0 });
    }
  }
  return new Map(
    [...seats].map(([who, m]) => [who, m.more > 0 ? `${m.topic} +${m.more}` : m.topic]),
  );
}
