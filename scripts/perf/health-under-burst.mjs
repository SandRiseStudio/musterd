/**
 * `/health` under burst — does the daemon answer its liveness probe while the request path is busy?
 *
 * WHY THIS EXISTS. The guardian calls `/health` on a timeout and reports `daemon_down` when it does
 * not answer. Four of those alarms (2026-08-14, 08-17 x2, 08-19) were false: the daemon was healthy
 * and the process never died. `/health` is about 1.5ms of real work, so the only way it misses is by
 * waiting behind something else — Node runs one thread, and every store call here is synchronous
 * better-sqlite3. A handler that holds the loop for 700ms makes `/health` miss by 700ms no matter how
 * cheap `/health` itself is, and no matter whether a request or a timer started the work.
 *
 * That last clause is the point worth keeping: moving derivation "off the request path" onto a timer
 * does NOT by itself fix this, because the timer callback runs on the same thread. What fixes it is
 * bounding the work, or chunking it so the loop can breathe. This bench measures the symptom the
 * guardian actually sees, so either fix can be judged by it.
 *
 * WHAT IT MEASURES. A real server over a real HTTP socket, seeded to the shape production actually
 * has (measured on revive 2026-08-19): enrolled seats keep a current cursor and carry tens of unread
 * acts, while seats that never read — guardian, autorefresh, the `web-*` observers — accumulate
 * thousands and grow without bound. Load is the traffic the daemon really serves, weighted the way it
 * really arrives:
 *
 *   - `/inbox/interrupt-check`, by far the most frequent — a PostToolUse hook runs it at EVERY tool
 *     boundary of every live agent, and it is documented as sub-50ms;
 *   - `/inbox`, the read a seat does when it checks messages;
 *   - `POST /residency/wake-leases`, the host's 30s poll.
 *
 * A separate prober hits `/health` throughout and reports its latency distribution. p99 is what the
 * guardian experiences; max is what trips it.
 *
 *   node scripts/perf/health-under-burst.mjs
 *   SEATS=6 DEEP=4000 ROUNDS=60 node scripts/perf/health-under-burst.mjs
 *
 * Exits non-zero if `/health` p99 exceeds BUDGET_MS.
 */
import { makeEnvelope } from '@musterd/protocol';
import { openDb } from '../../packages/server/dist/db/open.js';
import { createServer } from '../../packages/server/dist/index.js';
import { addMember } from '../../packages/server/dist/store/members.js';
import { insertMessage } from '../../packages/server/dist/store/messages.js';
import { enrollResidency } from '../../packages/server/dist/store/residency.js';
import { createTeam, rotateAgentKey } from '../../packages/server/dist/store/teams.js';

/** Live, enrolled seats — the ones that read their inbox, so their cursor stays current. */
const SEATS = Number(process.env.SEATS ?? 6);
/** Unread depth for the seats that never read. Measured at 4070 on revive, and monotonically rising. */
const DEEP = Number(process.env.DEEP ?? 4000);
/** Shallow unread for a live seat. Measured 0-65 on revive. */
const SHALLOW = Number(process.env.SHALLOW ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 60);
/** The guardian's experience. ADR 131 lane acceptance: /health p99 under 100ms. */
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 100);
const HOST = 'bench.host';

const db = openDb(':memory:');
const team = createTeam(db, { slug: 'bench' });
const { agent_key: KEY } = rotateAgentKey(db, team.id);
const nick = addMember(db, team, { name: 'nick', kind: 'human' }).row;

const live = [];
for (let i = 0; i < SEATS; i++) {
  const m = addMember(db, team, { name: `seat${i}`, kind: 'agent' }).row;
  enrollResidency(db, team.id, {
    member_id: m.id,
    harness: 'claude-code',
    host: HOST,
    grant_id: 'g1',
    authorized_by: 'nick',
  });
  live.push(m);
}
// The seats that never read: guardian, autorefresh, the web-* observers. No cursor, ever.
for (const name of ['guardian', 'autorefresh', 'web-a', 'web-b']) {
  addMember(db, team, { name, kind: 'agent' });
}

let ts = 1_000;
const say = (from, to, act, id, meta = null) =>
  insertMessage(
    db,
    team.id,
    from.id,
    to?.id ?? null,
    makeEnvelope({
      id,
      team: team.slug,
      from: from.name,
      to: to ? { kind: 'member', name: to.name } : { kind: 'team' },
      act,
      body: 'x',
      thread: null,
      meta,
      ts: ts++,
    }),
  );

// The backlog every seat is a party to — this is what the silent seats have never read.
for (let i = 0; i < DEEP; i++)
  say(i % 3 === 0 ? nick : live[i % SEATS], null, 'status_update', `d${i}`);
// Live seats read up to here, so their cursors are current against the backlog above.
const cursorTs = ts;
for (const m of [...live]) {
  db.prepare(
    'INSERT OR REPLACE INTO inbox_cursors (member_id, last_read_ts, updated_at) VALUES (?, ?, ?)',
  ).run(m.id, cursorTs, Date.now());
}
// ...and then a shallow tail of genuinely unread acts, plus one directed act each: the burst.
for (let i = 0; i < SHALLOW; i++) say(nick, null, 'status_update', `s${i}`);
for (const m of live)
  say(nick, m, 'message', `burst-${m.name}`, { urgent: true, urgent_reason: 'burst' });

const server = createServer({ db, port: 0, host: '127.0.0.1', rosterRoots: [] });
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;
const seatHeaders = (seat) => ({ authorization: `Bearer ${KEY}`, 'x-musterd-seat': seat });

// Warm up before measuring: the first request through any route prepares its statements and pays
// V8's first-call cost, so probe #1 was reliably the slowest sample in every run and dominated a p99
// taken over a few dozen probes. That is a real cost, but it is a once-per-process one — it tells you
// nothing about whether the daemon holds the loop in steady state, which is the question here.
for (let i = 0; i < 3; i++) {
  await fetch(`${base}/health`).then((r) => r.text());
  await fetch(`${base}/teams/${team.slug}/inbox/interrupt-check`, {
    headers: seatHeaders(live[0].name),
  }).then((r) => r.text());
  await fetch(`${base}/teams/${team.slug}/inbox?unread=1`, {
    headers: seatHeaders(live[0].name),
  }).then((r) => r.text());
}

const health = [];

let probes = 0;
let stop = false;
const prober = (async () => {
  while (!stop) {
    const t0 = performance.now();
    const r = await fetch(`${base}/health`);
    await r.text();
    health.push(performance.now() - t0);
    probes++;
    await new Promise((r) => setImmediate(r));
  }
})();

const t0 = performance.now();
for (let round = 0; round < ROUNDS; round++) {
  const seat = live[round % SEATS].name;
  // The hook rail: every tool boundary, every agent.
  await fetch(`${base}/teams/${team.slug}/inbox/interrupt-check`, {
    headers: seatHeaders(seat),
  }).then((r) => r.text());
  // A seat reading its messages.
  if (round % 5 === 0) {
    await fetch(`${base}/teams/${team.slug}/inbox?unread=1`, { headers: seatHeaders(seat) }).then(
      (r) => r.text(),
    );
  }
  // The host's 30s wake poll.
  if (round % 10 === 0) {
    await fetch(`${base}/teams/${team.slug}/residency/wake-leases`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: HOST }),
    }).then((r) => r.text());
  }
}
const elapsed = performance.now() - t0;
stop = true;
await prober;
await server.close();

health.sort((a, b) => a - b);
const at = (q) => health[Math.min(health.length - 1, Math.floor(q * health.length))];
const p99 = at(0.99);
console.log(
  `seats=${SEATS} deep=${DEEP} shallow=${SHALLOW} rounds=${ROUNDS} load=${elapsed.toFixed(0)}ms health_probes=${probes}`,
);
console.log(
  `  /health  p50 ${at(0.5).toFixed(1)}ms   p99 ${p99.toFixed(1)}ms   max ${health.at(-1).toFixed(1)}ms   budget ${BUDGET_MS}ms`,
);
if (p99 > BUDGET_MS) {
  console.error(
    `FAIL: /health p99 ${p99.toFixed(1)}ms exceeds ${BUDGET_MS}ms — the probe is queued behind the request path`,
  );
  process.exit(1);
}
