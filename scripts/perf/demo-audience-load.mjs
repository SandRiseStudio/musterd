/**
 * Demo audience load — can one laptop daemon carry a room of phones joining at once?
 *
 * WHY THIS EXISTS. The Oct 7 demo (goal `demo`, 2026-09-25 reset) puts the audience on the team:
 * each attendee signs in as a HUMAN member over OAuth remote MCP from a phone, may create an agent
 * seat on their own device, and watches the team work on /live. That is tens of seats arriving in a
 * minute on a daemon whose last live saturation was ~12 seats (docs/perf/daemon-load-baseline.md).
 * `health-under-burst.mjs` sends one request at a time, so it measures loop hold per request, not
 * what happens when a room hits the daemon concurrently. This is that concurrent instrument.
 *
 * WHAT IT MODELS. Three populations, each on its own timers with jitter, all concurrent:
 *
 *   - HUMANS (phones, remote MCP): the RELEASED rail (ADR 446, merged #1694) — the OAuth leg on
 *     arrival (dynamic client registration → authorize → token, PKCE), then MCP `tools/call`
 *     frames over Streamable HTTP at /mcp/:team, a bearer per call, no WS and no claim. Every
 *     ~20s one tool: team_inbox_check, team_send, or a fuller inbox read. Loopback runs present
 *     what the Cloudflare edge would (`x-forwarded-proto: https`, a distinct `cf-connecting-ip`
 *     per attendee) against a trustProxy daemon — the tunnel posture, including the per-IP OAuth
 *     rate buckets. HUMAN_RAIL=rest keeps the pre-446 modeled shape (plain REST with a pre-minted
 *     credential) for A/B against the 2026-09-25 baseline.
 *   - AGENTS (an attendee's harness): claims once, then the hook rail — interrupt-check at every tool
 *     boundary (~3s), an inbox read every ~30s, a status_update every ~90s, a lane opened every ~5 min
 *     (each lane act fans out as a /report refetch on every viewer), and the CLI hook re-claim churn.
 *   - VIEWERS (/live on the same phones): the page's real behaviour from packages/web/src/live —
 *     initial roster + history + report, a WS `team-all` subscription, then a roster refetch on EVERY
 *     presence frame (coalesced to one per second since 2026-09-25; ROSTER=every models the old page)
 *     and a /report refetch on every lane act. That fan-out is O(viewers × events).
 *
 * The daemon runs in a CHILD process so the client load does not share its event loop; the child
 * reports its own event-loop delay (perf_hooks) and CPU. A `/health` prober runs throughout.
 *
 *   node scripts/perf/demo-audience-load.mjs
 *   HUMANS=50 AGENTS=50 VIEWERS=50 DURATION=90 RAMP=30 node scripts/perf/demo-audience-load.mjs
 *   DB_COPY=/path/to/copy-of-musterd.db TEAM=revive node scripts/perf/demo-audience-load.mjs
 *   ROSTER=every node scripts/perf/demo-audience-load.mjs   # the /live roster rule before 2026-09-25
 *   HUMAN_RAIL=rest node scripts/perf/demo-audience-load.mjs   # the pre-ADR-446 modeled human shape
 *   PORT=4851 REMOTE_URL=https://bench.example.org node scripts/perf/demo-audience-load.mjs
 *     # the tunnel leg: cloudflared on this box points at 127.0.0.1:4851; HUMANS go the long way
 *     # (OAuth + /mcp through the edge) while agents/viewers stay loopback. Through a real tunnel
 *     # the edge writes cf-connecting-ip (and refuses a client that sends one), so every human
 *     # shares the driver's ONE address — stretch RAMP so arrivals stay under the per-IP OAuth
 *     # limits (register 5/min: RAMP ≥ 12s per human), set DURATION past RAMP so every arrival
 *     # lands in the sample, and read the arrival-burst numbers from a loopback run instead.
 *   DAEMON_CPUS=0 taskset -c 1-7 node scripts/perf/demo-audience-load.mjs   # Linux: isolate the daemon
 *
 * Do not run it at audience scale on a laptop: the client side alone saturates one. It runs on a
 * throwaway Fly machine — scripts/perf/loadbench.fly.toml.
 *
 * DB_COPY opens a COPY of a real database (never the live one — this writes to it) so /lanes and
 * /report carry production-sized boards. Without it a synthetic board of LANES lanes is seeded.
 * Results are logged in docs/perf/daemon-load-baseline.md. Exits non-zero if p95 over all requests
 * exceeds BUDGET_MS.
 */
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = (k, d) => Number(process.env[k] ?? d);

if (process.argv[2] === '--server') await serve();
else await drive();

// ── the daemon side ───────────────────────────────────────────────────────────────────────────

async function serve() {
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const { openDb } = await import('../../packages/server/dist/db/open.js');
  const { createServer } = await import('../../packages/server/dist/index.js');
  const { addMember, mintAgentSeatCredential, mintCredential } =
    await import('../../packages/server/dist/store/members.js');
  const { createTeam, getTeamBySlug } = await import('../../packages/server/dist/store/teams.js');
  const { openLane } = await import('../../packages/server/dist/store/lanes.js');

  const HUMANS = env('HUMANS', 50);
  const AGENTS = env('AGENTS', 50);
  const LANES = env('LANES', 1200);
  const dbPath = process.env.DB_COPY;
  const db = openDb(dbPath ?? ':memory:');
  let team;
  if (dbPath) {
    team = getTeamBySlug(db, process.env.TEAM ?? 'revive');
    if (!team) throw new Error(`no team ${process.env.TEAM ?? 'revive'} in ${dbPath}`);
  } else {
    team = createTeam(db, { slug: 'bench' });
    const owner = addMember(db, team, { name: 'owner', kind: 'human' }).row;
    // A board the size of revive's (1218 lanes on 2026-09-24), with a realistic `detail` body —
    // it is `detail` that makes GET /lanes 2.5 MB.
    const detail = 'Done when: '.padEnd(1800, 'the acceptance criteria are met and recorded. ');
    for (let i = 0; i < LANES; i++) {
      openLane(
        db,
        team.id,
        team.slug,
        owner.name,
        { title: `bench lane ${i}`, detail, scope: [`packages/p${i % 40}/**`] },
        1_000 + i,
      );
    }
  }
  const stamp = Date.now().toString(36);
  const humans = [];
  for (let i = 0; i < HUMANS; i++) {
    const m = addMember(db, team, { name: `aud-${stamp}-h${i}`, kind: 'human' }).row;
    humans.push({ name: m.name, token: mintCredential(db, m.id).credential });
  }
  const agents = [];
  for (let i = 0; i < AGENTS; i++) {
    const m = addMember(db, team, { name: `aud-${stamp}-a${i}`, kind: 'agent' }).row;
    agents.push({ name: m.name, token: mintAgentSeatCredential(db, m.id).seat_credential });
  }

  // trustProxy is the demo daemon's posture (`--insecure-trust-proxy`, the tunnel runbook §3):
  // the TLS check and the OAuth rate-limit key read the forwarded headers, which is exactly what
  // the human rail presents. PORT pins the bind for a cloudflared origin (REMOTE_URL runs).
  // The tunnel hostname must be on the Host allowlist, as on the demo daemon — otherwise the
  // Host/Origin gate answers every tunneled request 403 before any route runs.
  if (process.env.REMOTE_URL)
    process.env.MUSTERD_ALLOWED_HOSTS = new URL(process.env.REMOTE_URL).hostname;
  const server = createServer({
    db,
    port: env('PORT', 0),
    host: '127.0.0.1',
    rosterRoots: [],
    trustProxy: (process.env.HUMAN_RAIL ?? 'mcp') === 'mcp',
  });
  const { port } = await server.listen();
  const eld = monitorEventLoopDelay({ resolution: 10 });

  process.on('message', async (msg) => {
    if (msg.type === 'start') {
      eld.reset();
      eld.enable();
      process.send({ type: 'started', cpu0: process.cpuUsage(), t0: performance.now() });
    } else if (msg.type === 'stop') {
      eld.disable();
      const ms = (ns) => ns / 1e6;
      process.send({
        type: 'stats',
        cpu: process.cpuUsage(msg.cpu0),
        wallMs: performance.now() - msg.t0,
        eld: { p50: ms(eld.percentile(50)), p99: ms(eld.percentile(99)), max: ms(eld.max) },
        rssMb: process.memoryUsage().rss / 2 ** 20,
      });
      await server.close();
      process.exit(0);
    }
  });
  process.send({ type: 'ready', port, team: team.slug, humans, agents });
}

// ── the audience side ─────────────────────────────────────────────────────────────────────────

async function drive() {
  const { WebSocket } = await import('../../packages/server/node_modules/ws/wrapper.mjs');
  const { makeEnvelope, PROTOCOL_VERSION } = await import('@musterd/protocol');
  const { createHash, randomBytes } = await import('node:crypto');

  const VIEWERS = env('VIEWERS', 50);
  const DURATION = env('DURATION', 60) * 1000;
  const RAMP = env('RAMP', 20) * 1000;
  // Arrivals are spread over RAMP from t=0 and the sample stops at DURATION, so DURATION ≤ RAMP
  // silently drops the late arrivals from the result (2026-09-25 tunnel run: 16 of 50 humans).
  if (DURATION <= RAMP)
    throw new Error(`DURATION (${DURATION / 1000}s) must exceed RAMP (${RAMP / 1000}s)`);
  const BUDGET_MS = env('BUDGET_MS', 1000);
  /** `coalesced` (the page since 2026-09-25) or `every` (a roster fetch per presence frame, before). */
  const ROSTER = process.env.ROSTER ?? 'coalesced';
  const ROSTER_GAP_MS = env('ROSTER_GAP_MS', 1000);
  /** `mcp` (the released ADR 446 rail) or `rest` (the pre-446 modeled shape, for A/B). */
  const HUMAN_RAIL = process.env.HUMAN_RAIL ?? 'mcp';
  /** Public origin for the human rail only (the tunnel leg); agents/viewers stay loopback. */
  const REMOTE_URL = process.env.REMOTE_URL?.replace(/\/$/, '') ?? null;

  // DAEMON_CPUS (Linux) pins the daemon to those cores with taskset, so the audience cannot steal its
  // CPU — run the driver itself under `taskset -c <the other cores>` for the same reason. Without it
  // the two share the machine, which is what made the first laptop run (2026-09-25) unreadable.
  const self = fileURLToPath(import.meta.url);
  const childOpts = {
    env: { ...process.env, MUSTERD_SILENT: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  };
  const child = process.env.DAEMON_CPUS
    ? spawn(
        'taskset',
        ['-c', process.env.DAEMON_CPUS, process.execPath, self, '--server'],
        childOpts,
      )
    : fork(self, ['--server'], childOpts);
  const next = (type) =>
    new Promise((res) => {
      const on = (m) => {
        if (m.type === type) {
          child.off('message', on);
          res(m);
        }
      };
      child.on('message', on);
    });
  const ready = await next('ready');
  const base = `http://127.0.0.1:${ready.port}`;
  const T = `/teams/${ready.team}`;

  /** Per-endpoint latency samples, keyed by a route label (never a raw path — no ids, no tokens). */
  const samples = new Map();
  let errors = 0;
  const errorsByRoute = new Map();
  const fail = (label, what) => {
    errors++;
    errorsByRoute.set(`${label} ${what}`, (errorsByRoute.get(`${label} ${what}`) ?? 0) + 1);
  };
  /** One timed exchange; the raw response survives for callers that need headers (OAuth 302). */
  const timed = async (label, url, init = {}) => {
    const t0 = performance.now();
    try {
      const r = await fetch(url, init);
      const body = await r.arrayBuffer();
      const ms = performance.now() - t0;
      if (!samples.has(label)) samples.set(label, { ms: [], bytes: 0 });
      const s = samples.get(label);
      s.ms.push(ms);
      s.bytes = Math.max(s.bytes, body.byteLength);
      if (r.status >= 400) {
        fail(label, r.status);
        return null;
      }
      return { res: r, body: Buffer.from(body) };
    } catch {
      fail(label, 'net');
      return null;
    }
  };
  /** JSON body, or the data frames of an SSE body (how Streamable HTTP answers a POST). */
  const parseBody = (label, out) => {
    if (!out || out.body.byteLength === 0) return null;
    try {
      const ctype = out.res.headers.get('content-type') ?? '';
      const text = out.body.toString('utf8');
      if (!ctype.includes('text/event-stream')) return JSON.parse(text);
      const data = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      return data ? JSON.parse(data) : null;
    } catch {
      fail(label, 'parse');
      return null;
    }
  };
  const req = async (label, path, init = {}, origin = base) =>
    parseBody(label, await timed(label, origin + path, init));

  let stopping = false;
  const timers = new Set();
  const jitter = (ms) => ms * (0.5 + Math.random());
  const every = (ms, fn) => {
    const tick = async () => {
      if (stopping) return;
      await fn();
      if (!stopping) timers.add(setTimeout(tick, jitter(ms)));
    };
    timers.add(setTimeout(tick, jitter(ms)));
  };
  const arrive = (i, n, fn) => timers.add(setTimeout(fn, (RAMP * i) / Math.max(1, n)));
  let seq = 0;
  const envelope = (from, act, meta = null) =>
    makeEnvelope({
      id: `aud-${process.pid}-${seq++}`,
      team: ready.team,
      from,
      to: { kind: 'team' },
      act,
      body: 'bench',
      thread: null,
      meta,
      ts: Date.now(),
    });

  // Humans on the released rail (ADR 446): the OAuth leg on arrival, then MCP tools/call frames.
  // The edge headers are what cloudflared + Cloudflare present to a trustProxy daemon; through a
  // REMOTE_URL tunnel the edge overwrites them, so they are only load-bearing on loopback.
  const humanOrigin = REMOTE_URL ?? base;
  const REDIRECT = 'https://app.example/cb';
  const signIn = async (h, edge) => {
    const form = (o) => new URLSearchParams(o).toString();
    const verifier = randomBytes(32).toString('base64url');
    const reg = await req(
      'POST /oauth/register (human)',
      `/oauth/${ready.team}/register`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...edge },
        body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'bench phone' }),
      },
      humanOrigin,
    );
    if (!reg?.client_id) return null;
    const authz = await timed(
      'POST /oauth/authorize (human)',
      `${humanOrigin}/oauth/${ready.team}/authorize`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...edge },
        body: form({
          client_id: reg.client_id,
          redirect_uri: REDIRECT,
          state: 's',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          member: h.name,
          credential: h.token,
        }),
      },
    );
    const location = authz?.res.headers.get('location');
    const code = location ? new URL(location).searchParams.get('code') : null;
    if (!code) {
      if (authz) fail('POST /oauth/authorize (human)', 'no-code');
      return null;
    }
    const tok = await req(
      'POST /oauth/token (human)',
      `/oauth/${ready.team}/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...edge },
        body: form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: reg.client_id,
          code_verifier: verifier,
        }),
      },
      humanOrigin,
    );
    return tok?.access_token ?? null;
  };
  let rpcSeq = 0;
  if (HUMAN_RAIL === 'mcp')
    ready.humans.forEach((h, i) =>
      arrive(i, ready.humans.length, async () => {
        // Loopback only: a real edge writes these itself, and Cloudflare refuses a client request
        // that carries CF-Connecting-IP outright (403 "error code: 1000") — so through REMOTE_URL
        // every human would die at the edge before reaching the daemon.
        const edge = REMOTE_URL
          ? {}
          : { 'x-forwarded-proto': 'https', 'cf-connecting-ip': `198.51.100.${(i % 200) + 1}` };
        const bearer = await signIn(h, edge);
        if (!bearer) return;
        let session = null;
        const rpc = async (label, method, params) => {
          const out = await timed(label, `${humanOrigin}/mcp/${ready.team}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              authorization: `Bearer ${bearer}`,
              ...(session ? { 'mcp-session-id': session } : {}),
              ...edge,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: `aud-${rpcSeq++}`, method, params }),
          });
          if (out) session = out.res.headers.get('mcp-session-id') ?? session;
          return parseBody(label, out);
        };
        const call = (label, name, args) => rpc(label, 'tools/call', { name, arguments: args });
        await rpc('POST /mcp initialize (human)', 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bench-phone', version: '0' },
        });
        await call('POST /mcp team_join (human)', 'team_join', {});
        every(20_000, async () => {
          const r = Math.random();
          if (r < 0.55)
            await call('POST /mcp inbox (human)', 'team_inbox_check', { unread_only: true });
          else if (r < 0.8)
            await call('POST /mcp send (human)', 'team_send', { act: 'message', body: 'bench' });
          else await call('POST /mcp inbox-full (human)', 'team_inbox_check', { limit: 50 });
        });
      }),
    );
  // The pre-446 modeled shape (HUMAN_RAIL=rest): plain REST with the pre-minted credential.
  else
    ready.humans.forEach((h, i) =>
      arrive(i, ready.humans.length, () => {
        const headers = { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' };
        every(20_000, async () => {
          const r = Math.random();
          if (r < 0.5) await req('GET /inbox (human)', `${T}/inbox?unread=1`, { headers });
          else if (r < 0.7)
            await req('POST /messages (human)', `${T}/messages`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ envelope: envelope(h.name, 'message') }),
            });
          else if (r < 0.9) await req('GET /teams/:slug (human)', T, { headers });
          else await req('GET /lanes (human)', `${T}/lanes`, { headers });
        });
      }),
    );

  // Agents: claim, then the hook rail.
  ready.agents.forEach((a, i) =>
    arrive(i, ready.agents.length, async () => {
      let lease = null;
      const claim = async () => {
        const j = await req('POST /claim (agent)', `${T}/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: a.token, target: { seat: a.name }, surface: 'cli' }),
        });
        if (j?.session_lease) lease = j.session_lease;
      };
      await claim();
      const headers = () => ({
        authorization: `Bearer ${a.token}`,
        'content-type': 'application/json',
        ...(lease ? { 'x-musterd-session-lease': lease } : {}),
      });
      every(3_000, () =>
        req('GET /inbox/interrupt-check', `${T}/inbox/interrupt-check`, { headers: headers() }),
      );
      every(30_000, () => req('GET /inbox (agent)', `${T}/inbox?unread=1`, { headers: headers() }));
      every(90_000, () =>
        req('POST /messages (agent)', `${T}/messages`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ envelope: envelope(a.name, 'status_update') }),
        }),
      );
      every(300_000, () =>
        req('POST /lanes', `${T}/lanes`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ title: `aud lane ${seq++}`, claim: true }),
        }),
      );
      every(120_000, claim);
    }),
  );

  // Viewers: /live on the humans' phones.
  const sockets = [];
  let presenceFrames = 0;
  let laneFrames = 0;
  ready.humans.slice(0, VIEWERS).forEach((h, i) =>
    arrive(i, VIEWERS, async () => {
      const headers = { authorization: `Bearer ${h.token}`, 'x-musterd-surface': 'web' };
      await Promise.all([
        req('GET /teams/:slug (viewer)', T, { headers }),
        req('GET /messages (viewer)', `${T}/messages?limit=200`, { headers }),
        req('GET /report (viewer)', `${T}/report`, { headers }),
      ]);
      // The page's roster rule (packages/web/src/live/coalesce.ts): the first presence frame fetches
      // at once; frames during that fetch or within ROSTER_GAP_MS of its start fold into one more.
      let inFlight = false;
      let pending = false;
      let timer = null;
      let lastStart = -Infinity;
      const startFetch = () => {
        timer = null;
        if (stopping) return;
        pending = false;
        inFlight = true;
        lastStart = Date.now();
        req('GET /teams/:slug (viewer)', T, { headers }).finally(() => {
          inFlight = false;
          if (pending) schedule();
        });
      };
      const schedule = () => {
        if (timer) return;
        timer = setTimeout(startFetch, Math.max(0, lastStart + ROSTER_GAP_MS - Date.now()));
        timers.add(timer);
      };
      const rosterRefetch = () => {
        if (inFlight || timer || Date.now() - lastStart < ROSTER_GAP_MS) {
          pending = true;
          if (!inFlight) schedule();
        } else startFetch();
      };
      const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws`);
      sockets.push(ws);
      let hb;
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'claim',
            v: PROTOCOL_VERSION,
            team: ready.team,
            key: h.token,
            target: { seat: h.name },
            surface: 'web',
            provenance: 'session',
          }),
        ),
      );
      ws.on('message', (data) => {
        let f;
        try {
          f = JSON.parse(String(data));
        } catch {
          return;
        }
        if (f.type === 'occupied') {
          ws.send(JSON.stringify({ type: 'subscribe', scope: 'team-all' }));
          hb = setInterval(() => ws.send(JSON.stringify({ type: 'heartbeat' })), 15_000);
        } else if (f.type === 'presence' && !stopping) {
          presenceFrames++;
          if (ROSTER === 'every') void req('GET /teams/:slug (viewer)', T, { headers });
          else rosterRefetch();
        } else if (f.type === 'deliver' && !stopping) {
          const meta = f.envelope?.meta ?? {};
          if (Object.keys(meta).some((k) => k.startsWith('lane_'))) {
            laneFrames++;
            void req('GET /report (viewer)', `${T}/report`, { headers });
          }
        }
      });
      ws.on('close', () => clearInterval(hb));
      ws.on('error', () => {
        errors++;
      });
    }),
  );

  // The guardian's view.
  const health = [];
  const prober = (async () => {
    while (!stopping) {
      const t0 = performance.now();
      await fetch(`${base}/health`)
        .then((r) => r.arrayBuffer())
        .catch(() => null);
      health.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 250));
    }
  })();

  child.send({ type: 'start' });
  const started = await next('started');
  await new Promise((r) => setTimeout(r, DURATION));
  stopping = true;
  for (const t of timers) clearTimeout(t);
  await prober;
  child.send({ type: 'stop', cpu0: started.cpu0, t0: started.t0 });
  const stats = await next('stats');
  for (const ws of sockets) ws.terminate();

  // ── report ──
  const pct = (xs, q) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
  };
  const f = (n) => (Number.isFinite(n) ? n.toFixed(0).padStart(6) : '     -');
  const all = [...samples.values()].flatMap((s) => s.ms);
  const cpuPct = ((stats.cpu.user + stats.cpu.system) / 1e3 / stats.wallMs) * 100;
  console.log(
    `humans=${ready.humans.length} agents=${ready.agents.length} viewers=${VIEWERS} ` +
      `daemon_cpus=${process.env.DAEMON_CPUS ?? 'shared'} roster=${ROSTER} ` +
      `human_rail=${HUMAN_RAIL} human_origin=${REMOTE_URL ? 'tunnel' : 'loopback'} ` +
      `duration=${DURATION / 1000}s ramp=${RAMP / 1000}s db=${process.env.DB_COPY ? 'copy' : 'synthetic'}`,
  );
  console.log(
    `daemon  cpu ${cpuPct.toFixed(0)}%  rss ${stats.rssMb.toFixed(0)} MB  ` +
      `loop delay p50 ${stats.eld.p50.toFixed(1)} p99 ${stats.eld.p99.toFixed(1)} max ${stats.eld.max.toFixed(0)} ms`,
  );
  console.log(
    `requests ${all.length} (${(all.length / (DURATION / 1000)).toFixed(1)}/s)  errors ${errors}  ` +
      `presence frames ${presenceFrames}  lane frames ${laneFrames}`,
  );
  for (const [k, v] of errorsByRoute) console.log(`  error ${k}: ${v}`);
  console.log(`  ${'route'.padEnd(34)} calls    p50    p95    p99    max  max body`);
  const rows = [...samples.entries()].sort((a, b) => pct(b[1].ms, 0.95) - pct(a[1].ms, 0.95));
  for (const [k, s] of rows)
    console.log(
      `  ${k.padEnd(34)}${String(s.ms.length).padStart(6)}${f(pct(s.ms, 0.5))}${f(pct(s.ms, 0.95))}` +
        `${f(pct(s.ms, 0.99))}${f(Math.max(...s.ms))}  ${(s.bytes / 1024).toFixed(0)} KB`,
    );
  console.log(
    `  ${'/health (prober)'.padEnd(34)}${String(health.length).padStart(6)}${f(pct(health, 0.5))}` +
      `${f(pct(health, 0.95))}${f(pct(health, 0.99))}${f(Math.max(...health))}`,
  );
  const p95 = pct(all, 0.95);
  console.log(
    `all requests  p50 ${f(pct(all, 0.5))}  p95 ${f(p95)}  p99 ${f(pct(all, 0.99))} ms  budget p95 ${BUDGET_MS}`,
  );
  if (p95 > BUDGET_MS) {
    console.error(`FAIL: p95 ${p95.toFixed(0)}ms exceeds ${BUDGET_MS}ms`);
    process.exit(1);
  }
}
