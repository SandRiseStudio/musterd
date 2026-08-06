import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { routeEnvelope } from '../protocol/route.js';
import { appendAudit } from '../store/audit.js';
import { openLane } from '../store/lanes.js';
import { listMembers } from '../store/members.js';
import { resolveCapabilities } from '../store/rows.js';
import type { MemberRow } from '../store/rows.js';
import { getPolicy, listActiveTeams, requireTeam } from '../store/teams.js';

/**
 * Seeds ingest (ADR 248) — the daemon's half of the one-way flow. The relay Worker captured a raw
 * idea and buffered it verbatim; this loop pulls anything new and turns each seed into an ordinary
 * lane: open state, unowned, stakes normal. LIGHT CLEANUP ONLY — a deterministic title/detail
 * split, no reasoning, no tagging, no stakes or goal suggestion, no duplicate detection. A seed
 * that arrives pre-judged is a lane someone has to argue with instead of edit; a rough title is
 * fixed on the lane itself.
 *
 * The relay buffer is the source of record and is never written back to. The daemon's only durable
 * state is a per-team cursor (`seeds_ingest_cursor`), advanced in the SAME transaction as each lane
 * insert so a crash mid-batch resumes without duplicating lanes. A dedicated table, not the audit
 * ledger read backwards — the `seed.ingested` row exists for observability, and giving it a second
 * consumer with different needs is the trap ADR 247 names.
 */

/** How often the daemon looks for new seeds. Idle cost is one conditional per tick per team;
 *  the outbound fetch happens only where policy sets both relay fields. */
export const SEEDS_POLL_INTERVAL_MS = 60_000;

/** Abandon a slow relay rather than let it stack ticks. */
const PULL_TIMEOUT_MS = 10_000;

/** Title budget: first line of the seed, collapsed, cut at a word break past this. */
const TITLE_MAX = 80;

export interface RelaySeed {
  id: string;
  body: string;
  ts: number;
  source: 'sms' | 'slack';
  meta?: Record<string, string>;
}

/**
 * Deterministic cleanup — the whole of what ingest may do to a seed. Title is the first non-empty
 * line, whitespace collapsed, truncated at a word boundary with an ellipsis. Detail is the raw body
 * verbatim plus a provenance trailer naming the channel, capture time, and relay id (so the source
 * of record is findable from the lane).
 */
export function seedToLane(seed: RelaySeed): { title: string; detail: string } {
  const lines = seed.body.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const first = lines.find((l) => l.length > 0) ?? '(empty seed)';
  let title = first;
  if (title.length > TITLE_MAX) {
    const cut = title.lastIndexOf(' ', TITLE_MAX);
    title = `${title.slice(0, cut > 40 ? cut : TITLE_MAX)}…`;
  }
  const captured = new Date(seed.ts).toISOString();
  const detail = `${seed.body.trim()}\n\n— seed via ${seed.source}, captured ${captured} (relay id ${seed.id}; raw preserved in the relay buffer)`;
  return { title, detail };
}

function lastSeedId(ctx: Ctx, teamId: string): string {
  const row = ctx.db
    .prepare<
      [string],
      { last_seed_id: string }
    >('SELECT last_seed_id FROM seeds_ingest_cursor WHERE team_id = ?')
    .get(teamId);
  return row?.last_seed_id ?? '';
}

/**
 * Who a seed's lane is attributed to: the team's human admin if there is one, else its first human
 * member. The seed came from a human's phone or Slack — attributing it to any agent seat would be
 * false provenance (ADR 109 posture). A team with no human member gets no seeds, logged once per tick.
 */
function seedAuthor(ctx: Ctx, teamId: string): MemberRow | null {
  const humans = listMembers(ctx.db, teamId).filter((m) => m.kind === 'human' && !m.left_at);
  return humans.find((m) => resolveCapabilities(m).is_admin) ?? humans[0] ?? null;
}

async function pullSeeds(url: string, token: string, after: string): Promise<RelaySeed[]> {
  const target = new URL('/seeds', url);
  if (after) target.searchParams.set('after', after);
  const res = await fetch(target, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`relay responded ${res.status}`);
  const parsed = (await res.json()) as { seeds?: RelaySeed[] };
  return Array.isArray(parsed.seeds) ? parsed.seeds : [];
}

/** One team's ingest pass: pull everything past the cursor, open one lane per seed. Exported for
 *  through-DB tests; the loop below is just this on a timer. */
export async function ingestTeamSeeds(
  ctx: Ctx,
  team: { id: string; slug: string },
  now: number = Date.now(),
): Promise<number> {
  const policy = getPolicy(ctx.db, team.id);
  const url = policy.seeds_relay_url;
  const token = policy.seeds_relay_token;
  if (!url || !token) return 0;

  const author = seedAuthor(ctx, team.id);
  if (!author) {
    log.warn({ msg: 'seeds_no_human_author', team: team.slug });
    return 0;
  }

  const seeds = await pullSeeds(url, token, lastSeedId(ctx, team.id));
  const teamRow = requireTeam(ctx.db, team.slug);
  let opened = 0;
  for (const seed of seeds) {
    const { title, detail } = seedToLane(seed);
    const tx = ctx.db.transaction(() => {
      const lane = openLane(ctx.db, team.id, team.slug, author.name, { title, detail }, now);
      ctx.db
        .prepare(
          `INSERT INTO seeds_ingest_cursor (team_id, last_seed_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(team_id) DO UPDATE SET last_seed_id = excluded.last_seed_id, updated_at = excluded.updated_at`,
        )
        .run(team.id, seed.id, now);
      appendAudit(ctx.db, team.id, {
        actor: author.name,
        action: 'seed.ingested',
        target: lane.id,
        result: 'allow',
        detail: { seed_id: seed.id, source: seed.source, lane: lane.id, captured_at: seed.ts },
      });
      return lane;
    });
    const lane = tx();
    opened += 1;
    // The same board message any lane_open produces — a seed IS a lane the moment it is ingested.
    routeEnvelope(
      ctx,
      teamRow,
      author,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: author.name,
        to: { kind: 'team' },
        act: 'message',
        body: `[lane] opened "${lane.title}" (seed via ${seed.source})`,
        meta: { lane_open: { lane: lane.id, title: lane.title, project: lane.project } },
      }),
      undefined,
      true,
    );
  }
  return opened;
}

/** Start the polling loop. Returns a stop function (same contract as startReaper). */
export function startSeedsIngest(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow relay must not stack passes
    running = true;
    try {
      for (const team of listActiveTeams(ctx.db)) {
        try {
          const opened = await ingestTeamSeeds(ctx, team);
          if (opened > 0) log.info({ msg: 'seeds_ingested', team: team.slug, opened });
        } catch (error) {
          // Offline is the expected failure mode (that is why the relay buffers); log and retry
          // next tick. Nothing is lost: the cursor did not move past anything unopened.
          log.warn({ msg: 'seeds_pull_failed', team: team.slug, error: String(error) });
        }
      }
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), SEEDS_POLL_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
