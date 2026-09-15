/**
 * Wake-poll burst bench — how long does `claimWakeLeases` hold the event loop?
 *
 * WHY THIS EXISTS. The host's wake poll runs `claimWakeLeases` **in one transaction** on the daemon's
 * request path, every 30s per enrolled seat, over synchronous better-sqlite3. Node has one thread, so
 * every millisecond it spends is a millisecond `/health` (~1.5ms of actual work) waits behind it. The
 * failure that motivated this is not a crash: the daemon stays up, the queue backs up, `/health`
 * exceeds the guardian's timeout, and the guardian reports `daemon_down` — a false alarm (observed
 * 2026-08-14, 08-17 x2, 08-19). So the thing to measure is the poll's *hold time*, not throughput.
 *
 * WHAT IT MEASURES. A synthetic team of `SEATS` enrolled, offline seats over a timeline of `MSGS`
 * team-wide acts, then a **burst**: every seat receives a directed urgent act at once, so every seat
 * derives a wake in the same poll. That first poll is the worst case and the number that matters; the
 * polls after it find live leases and return early, which is why the p50 is near zero and only the
 * tail is interesting. Reported as p50/p99/max over `POLLS` polls.
 *
 * WHY SYNTHETIC RATHER THAN THE LIVE DB. The live database gives one sample of one state, and whether
 * it is slow depends on whether a wake happens to be due at that instant — the same measurement ran
 * 840ms and 71ms twenty minutes apart for that reason alone. The burst is the state we care about, so
 * the bench constructs it instead of waiting for it.
 *
 * MSGS is the knob that exposes the scaling term: a seat whose cursor is behind pays for its unread
 * depth, so cost should grow with unread depth and with nothing else.
 *
 *   node scripts/perf/wake-bench.mjs                    # defaults
 *   SEATS=8 MSGS=24000 POLLS=6 node scripts/perf/wake-bench.mjs
 *
 * Exits non-zero if p99 exceeds BUDGET_MS, so it can gate.
 */
import { makeEnvelope } from '@musterd/protocol';
import { openDb } from '../../packages/server/dist/db/open.js';
import { addMember } from '../../packages/server/dist/store/members.js';
import { insertMessage } from '../../packages/server/dist/store/messages.js';
import { claimWakeLeases, enrollResidency } from '../../packages/server/dist/store/residency.js';
import { createTeam } from '../../packages/server/dist/store/teams.js';

const SEATS = Number(process.env.SEATS ?? 8);
const MSGS = Number(process.env.MSGS ?? 6000);
const POLLS = Number(process.env.POLLS ?? 20);
/** ADR 131 wake poll: 500ms is the lane's acceptance bar, chosen so it cannot mask a `/health` miss. */
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 500);
const HOST = 'bench.host';
const PRESENCE_TIMEOUT_MS = 45_000;

const db = openDb(':memory:');
const team = createTeam(db, { slug: 'bench' });
const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;

const seats = [];
for (let i = 0; i < SEATS; i++) {
  const m = addMember(db, team, { name: `seat${i}`, kind: 'agent' }).row;
  enrollResidency(db, team.id, {
    member_id: m.id,
    harness: 'claude-code',
    host: HOST,
    grant_id: 'g1',
    authorized_by: 'nick',
  });
  seats.push(m);
}

// The timeline every seat is a party to. Team-scoped, so no seat's window is narrowed by need-to-know.
let ts = 1_000;
for (let i = 0; i < MSGS; i++) {
  const from = i % 3 === 0 ? nick : seats[i % SEATS];
  insertMessage(
    db,
    team.id,
    from.id,
    null,
    makeEnvelope({
      id: `c${i}`,
      team: team.slug,
      from: from.name,
      to: { kind: 'team' },
      act: 'status_update',
      body: 'x',
      thread: null,
      meta: null,
      ts: ts++,
    }),
  );
}

// The burst: every seat becomes wake-eligible in the same poll.
for (const s of seats) {
  insertMessage(
    db,
    team.id,
    nick.id,
    s.id,
    makeEnvelope({
      id: `burst-${s.name}`,
      team: team.slug,
      from: 'nick',
      to: { kind: 'member', name: s.name },
      act: 'message',
      body: 'wake',
      thread: null,
      meta: { urgent: true, urgent_reason: 'burst' },
      ts: ts++,
    }),
  );
}

const samples = [];
let orders = 0;
for (let p = 0; p < POLLS; p++) {
  const t0 = performance.now();
  orders += claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS).length;
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
const p99 = at(0.99);

console.log(`seats=${SEATS} msgs=${MSGS} polls=${POLLS} orders=${orders}`);
console.log(
  `  p50 ${at(0.5).toFixed(1)}ms   p99 ${p99.toFixed(1)}ms   max ${samples.at(-1).toFixed(1)}ms   budget ${BUDGET_MS}ms`,
);
if (p99 > BUDGET_MS) {
  console.error(
    `FAIL: wake-poll p99 ${p99.toFixed(1)}ms exceeds ${BUDGET_MS}ms — the poll holds the loop`,
  );
  process.exit(1);
}
