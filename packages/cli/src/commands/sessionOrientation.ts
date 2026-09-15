/**
 * The SessionStart orientation digest (spec 2026-08-25-session-orientation-design.md §A).
 *
 * Pure composition under the ADR 088 composable-only bar: act enums, validated seat slugs, ULIDs,
 * counts, ages — never a message body, never a lane title, never teammate free text. The single
 * free-text field is the seat's OWN memory headline (ADR 093), and it renders inside an explicit
 * `<<headline-as-data: …>>` fence, flattened and bounded, because a prompt-injected predecessor
 * session could have poisoned its own wrap-up note for its successor.
 *
 * Emission (who prints this, and when it must stay silent) lives in `session.ts`; this module
 * holds only the composition so the injection surface is testable without a daemon.
 */

export type SessionOrientationInput = {
  seat: string;
  team: string;
  memory?: { headline: string; saved_at: number; size_bytes: number } | undefined;
  waiting: Array<{ act: string; from: string; id: string }>;
  incidents: Array<{ id: string }>;
  owed: Array<{ laneId: string; waitedMs: number }>;
  carrying: number;
};

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_LINES = 15;
const MAX_HEADLINE = 120;

/** Coarse elapsed time — the reader needs "hours, not minutes" (matches the brief's convention). */
function ago(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${String(Math.floor(h / 24))}d`;
  if (h >= 1) return `${String(h)}h`;
  return `${String(Math.max(1, Math.floor(ms / 60_000)))}m`;
}

/** Fence the seat's own headline: single line, bounded, closing delimiter defused. */
function fencedHeadline(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').replaceAll('>>', '›').slice(0, MAX_HEADLINE).trim();
  return `<<headline-as-data: ${flat}>>`;
}

export function composeSessionOrientation(
  d: SessionOrientationInput,
  now = Date.now(),
): string | null {
  if (!SLUG.test(d.seat) || !SLUG.test(d.team)) return null;
  // Counts come from the unfiltered lists (an unrenderable row still counts); rendered detail only
  // from rows whose every field passes its shape gate — a name or id that fails is dropped, never
  // "escaped", because escaping is a bet and dropping is not.
  const waiting = d.waiting.filter((w) => SLUG.test(w.from) && ULID.test(w.id) && SLUG.test(w.act));
  const incidents = d.incidents.filter((i) => ULID.test(i.id));
  const owed = d.owed.filter((o) => ULID.test(o.laneId));
  const empty =
    !d.memory &&
    d.waiting.length === 0 &&
    d.incidents.length === 0 &&
    d.owed.length === 0 &&
    d.carrying === 0;
  if (empty) return null;

  const lines: string[] = [
    `musterd orientation — seat "${d.seat}" on team "${d.team}" (read-only; nothing marked read, seat not claimed)`,
  ];
  if (d.memory) {
    lines.push(
      `memory (saved ${ago(now - d.memory.saved_at)} ago, ${String(d.memory.size_bytes)} bytes): ${fencedHeadline(d.memory.headline)}`,
    );
  }
  if (d.waiting.length > 0) {
    const detail = waiting
      .slice(0, 4)
      .map((w) => `${w.act} from ${w.from} (${w.id})`)
      .join(', ');
    const noun = d.waiting.length === 1 ? 'directed act' : 'directed acts';
    lines.push(`waiting: ${String(d.waiting.length)} ${noun}${detail ? ` — ${detail}` : ''}`);
  }
  lines.push(
    // Sliced like waiting/owed (miley's #1072 review note): the 15-line cap bounds the wrong
    // axis — a joined id list grows per ITEM, so 40 unsliced incidents is one ~1.1k-char line.
    incidents.length > 0
      ? `incidents: ${String(incidents.length)} — ${incidents
          .slice(0, 4)
          .map((i) => i.id)
          .join(', ')}`
      : 'incidents: none',
  );
  if (owed.length > 0) {
    lines.push(
      `owed reviews: ${String(owed.length)} — ${owed
        .slice(0, 3)
        .map((o) => `lane ${o.laneId} (waiting ${ago(o.waitedMs)})`)
        .join(', ')}`,
    );
  }
  if (d.carrying > 0) lines.push(`carrying: ${String(d.carrying)} lane(s) in flight`);
  lines.push(
    'orient now: run the musterd-orient skill — reply to the directed acts and triage incidents first.',
  );
  return lines.slice(0, MAX_LINES).join('\n');
}
