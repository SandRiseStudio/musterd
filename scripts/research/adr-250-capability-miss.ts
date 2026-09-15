/**
 * ADR 250 §Eval instrument 3 — "capability-miss count", as a re-runnable read.
 *
 * WHY THIS EXISTS. ADR 250 named three weekly reads; this is the third. Its named instance
 * (2026-08-05): six wakes landed on one lane in sessions without write approval — non-interactive,
 * no in-band grant possible — so each could only re-describe the same finished analysis, and the
 * lane never moved. The ADR's prediction: after backlog item 3 (capability fitness in routing)
 * lands, "any nonzero week is a routing bug by definition."
 *
 * READ-ONLY over `~/.musterd/musterd.db`. Touches no lane, no seat, no daemon. No spend.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/adr-250-capability-miss.ts [--json] [--days N]
 *
 * THE DEFINITION, and why it is this one.
 *
 * The wire carries no capability field — whether a session can write is nowhere in the ledger
 * (recording it is backlog item 3's own ADR, not this instrument). What the ledger DOES record is
 * the ADR's instance's observable shape: the wake LANDED and the lane DID NOT MOVE. So:
 *
 *   A LANDING is a wake_leases row with status='reported' and a lane_id — a lane-scoped wake the
 *   session acknowledged. (A lease row existing proves derivation AND delivery — ADR 250's
 *   amendment: leases are inserted inside the host's poll transaction, so there are no phantoms.)
 *
 *   A landing is INERT if no lane.* audit row names that lane within GRACE_MS of the lease's
 *   created_at. The ADR's instance sat inert through six consecutive wakes; a lane the woken
 *   session actually advances produces lane.claimed / state_changed / updated / ready_for_review /
 *   closed within the grace window.
 *
 *   A CAPABILITY-MISS REPEAT is an inert landing on a (member, lane, edge) seen inert before,
 *   counted as attempts-beyond-the-first — the same quantity instrument 2 (wakes:repeats) counts,
 *   one rail further down: not "the router re-derived the same wake" but "the wake landed and the
 *   same nothing happened again."
 *
 * WHAT THIS DOES NOT SAY. Inert ≠ incapable: a session can land on a lane and legitimately do
 * something else first, and a lane can be advanced by a different seat than the one woken (the
 * audit read is lane-scoped, not actor-scoped — the woken seat's teammates moving the lane clears
 * it, which is the conservative direction: this count UNDERSTATES true capability misses rather
 * than inventing them). Read it as the ADR's superset: the landed-and-inert count is the number
 * item 3's routing fitness must drive to ~zero, and any nonzero week after item 3 is a routing
 * bug by the ADR's own definition.
 *
 * TRAPS ALREADY PAID FOR. Timestamps come from wake_leases.created_at, never from lease_expired
 * audit rows — the amendment measured those written by a lazy sweep, 4–11s late. `edge` comes
 * from the lease row, not `derivation`: work_order is emitted by the review loop too, and the
 * amendment corrects that conflation in public.
 *
 * ROWS THAT ALREADY EXIST. ADR 250 §Observability is explicit that its instruments read rows
 * already in the ledger. This reads `wake_leases`, `audit`, and `members` only.
 */
// `node:sqlite`, not better-sqlite3: that dependency lives in packages/server, and a research script
// that has to be run from inside a workspace package is a script nobody re-runs.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The frozen baseline ADR 250 §Context quotes, for the printed comparison. */
export const BASELINE = {
  taken: '2026-08-05',
  note: 'six wakes landed on one lane in sessions without write approval; the lane never moved',
};

/** How long a landed wake has to move its lane before it counts as inert. */
export const GRACE_MS = 24 * 60 * 60 * 1000;

export interface LeaseRow {
  id: string;
  member_id: string;
  lane_id: string | null;
  edge: string | null;
  status: string;
  created_at: number;
}

export interface LaneEventRow {
  ts: number;
  target: string | null;
}

export interface InertGroup {
  member: string;
  lane: string;
  edge: string;
  ts: number[];
}

/** Field separator for the group key — NUL, not a space (reasons/edges contain spaces). */
const SEP = '\u0000';

/**
 * Fold landed leases into inert groups. A landing whose lane shows any lane.* audit row within
 * [created_at, created_at + GRACE_MS) is live and contributes nothing. The lane-events map is
 * lane_id → sorted timestamps, built once — the pure halves take it as an argument so the tests
 * never touch a database.
 */
export function inertLandings(
  leases: LeaseRow[],
  laneEvents: Map<string, number[]>,
  memberNames: Map<string, string>,
  graceMs: number = GRACE_MS,
): { groups: InertGroup[]; landings: number; inert: number } {
  const groups = new Map<string, InertGroup>();
  let landings = 0;
  let inert = 0;
  for (const l of leases) {
    if (l.status !== 'reported' || !l.lane_id) continue;
    landings++;
    const events = laneEvents.get(l.lane_id) ?? [];
    // Binary search would do; the windows are short and clarity beats cleverness in an instrument.
    const moved = events.some((ts) => ts >= l.created_at && ts < l.created_at + graceMs);
    if (moved) continue;
    inert++;
    const member = memberNames.get(l.member_id) ?? l.member_id;
    const key = [member, l.lane_id, l.edge ?? '-'].join(SEP);
    const g = groups.get(key);
    if (g) g.ts.push(l.created_at);
    else groups.set(key, { member, lane: l.lane_id, edge: l.edge ?? '-', ts: [l.created_at] });
  }
  return { groups: [...groups.values()], landings, inert };
}

export interface Summary {
  landings: number;
  inert: number;
  share: number;
  repeatedGroups: number;
  repeats: number;
  worst: Array<{
    n: number;
    member: string;
    lane: string;
    edge: string;
    first: string;
    last: string;
    spanMinutes: number;
  }>;
}

export function summarize(r: { groups: InertGroup[]; landings: number; inert: number }): Summary {
  const repeated = r.groups.filter((g) => g.ts.length > 1);
  const worst = [...repeated].sort((a, b) => b.ts.length - a.ts.length).slice(0, 8);
  return {
    landings: r.landings,
    inert: r.inert,
    // An empty window reports 0, not NaN: a rail that landed no wakes has no inert landings, and
    // a NaN in a weekly read is the kind of thing a reader rounds to "fine".
    share: r.landings ? r.inert / r.landings : 0,
    repeatedGroups: repeated.length,
    repeats: repeated.reduce((s, g) => s + g.ts.length - 1, 0),
    worst: worst.map((g) => ({
      n: g.ts.length,
      member: g.member,
      lane: g.lane,
      edge: g.edge,
      first: new Date(g.ts[0]!).toISOString(),
      last: new Date(g.ts[g.ts.length - 1]!).toISOString(),
      spanMinutes: Math.round((g.ts[g.ts.length - 1]! - g.ts[0]!) / 60000),
    })),
  };
}

function read(dbPath: string, sinceMs: number | null) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const leases = db
      .prepare(
        `SELECT id, member_id, lane_id, edge, status, created_at FROM wake_leases
          WHERE (? IS NULL OR created_at >= ?)
          ORDER BY created_at`,
      )
      .all(sinceMs, sinceMs) as unknown as LeaseRow[];
    // Lane events are read over ALL time, not the window: a lease near the window's start can be
    // cleared by a lane event just before it, and truncating the read would invent inert landings.
    const laneRows = db
      .prepare(
        `SELECT ts, target FROM audit
          WHERE action IN ('lane.claimed','lane.updated','lane.state_changed','lane.ready_for_review','lane.closed','lane.released')
          ORDER BY ts`,
      )
      .all() as unknown as LaneEventRow[];
    const laneEvents = new Map<string, number[]>();
    for (const r of laneRows) {
      if (!r.target) continue;
      const arr = laneEvents.get(r.target);
      if (arr) arr.push(r.ts);
      else laneEvents.set(r.target, [r.ts]);
    }
    const members = db.prepare(`SELECT id, name FROM members`).all() as unknown as Array<{
      id: string;
      name: string;
    }>;
    return { leases, laneEvents, memberNames: new Map(members.map((m) => [m.id, m.name])) };
  } finally {
    db.close();
  }
}

export function render(dbPath: string, days: number | null, s: Summary): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const out: string[] = [];
  out.push('ADR 250 §Eval — capability-miss count (landed-and-inert lane wakes)');
  out.push(`db ${dbPath}${days ? `  ·  last ${days}d` : '  ·  all time'}`);
  out.push(`baseline (${BASELINE.taken}): ${BASELINE.note}`);
  out.push('');
  out.push(
    'A landing = a reported lane-scoped wake lease. Inert = no lane.* audit row for that lane',
  );
  out.push(
    `within ${GRACE_MS / 3_600_000}h of the lease. Inert understates true capability misses —`,
  );
  out.push('a lane moved by ANY seat clears the landing. That is the conservative direction.');
  out.push('');
  out.push(
    `${s.landings} landings · ${s.inert} inert (${pct(s.share)}) · ` +
      `${s.repeatedGroups} repeated (member,lane,edge) · ${s.repeats} repeats beyond the first`,
  );
  for (const w of s.worst) {
    out.push(
      `  ${String(w.n).padStart(3)}×  ${w.member} · ${w.lane} · ${w.edge}` +
        `  [${w.spanMinutes}m from ${w.first.slice(0, 16)}]`,
    );
  }
  out.push('');
  out.push('ADR 250 predicts ~zero once backlog item 3 (capability fitness in routing) lands;');
  out.push('after it, any nonzero week is a routing bug by definition. Item 3 has not landed.');
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const dIdx = argv.indexOf('--days');
  const days = dIdx >= 0 ? Number(argv[dIdx + 1]) : null;
  const since = days && Number.isFinite(days) ? Date.now() - days * 86_400_000 : null;

  const dbPath = process.env.MUSTERD_DB ?? join(homedir(), '.musterd', 'musterd.db');
  const { leases, laneEvents, memberNames } = read(dbPath, since);
  const r = inertLandings(leases, laneEvents, memberNames);
  const s = summarize(r);

  if (wantJson) {
    process.stdout.write(
      `${JSON.stringify({ db: dbPath, windowDays: days, graceMs: GRACE_MS, baseline: BASELINE, ...s }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`${render(dbPath, days, s)}\n`);
}

// Only when run directly — the test imports the pure halves and must not touch the live ledger.
if (process.argv[1]?.endsWith('adr-250-capability-miss.ts')) main();
