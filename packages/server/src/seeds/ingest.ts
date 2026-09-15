import { RelaySeedListSchema, type RelaySeed } from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { createSeedFromRelay } from '../store/seeds.js';
import { getPolicy, listActiveTeams } from '../store/teams.js';

/**
 * Seeds ingest (ADR 248) — the daemon's half of the one-way flow. The relay Worker captured a raw
 * idea and buffered it verbatim; this loop pulls anything new and creates a first-class shared Seed.
 * No Lane exists until exploration promotes the Seed (ADR 291). The Slack-only relay boundary and
 * durable human attribution are ADR 311.
 *
 * The relay buffer is the source of record and is never written back to. The daemon's only durable
 * state is a per-team cursor (`seeds_ingest_cursor`), advanced in the SAME transaction as each Seed
 * insert so a crash mid-batch resumes without duplicating records. A dedicated table, not the audit
 * ledger read backwards — the `seed.ingested` row exists for observability, and giving it a second
 * consumer with different needs is the trap ADR 247 names.
 */

/** How often the daemon looks for new seeds. Idle cost is one conditional per tick per team;
 *  the outbound fetch happens only where policy sets both relay fields. */
export const SEEDS_POLL_INTERVAL_MS = 60_000;

/** Abandon a slow relay rather than let it stack ticks. */
const PULL_TIMEOUT_MS = 10_000;

function lastSeedId(ctx: Ctx, teamId: string): string {
  const row = ctx.db
    .prepare<
      [string],
      { last_seed_id: string }
    >('SELECT last_seed_id FROM seeds_ingest_cursor WHERE team_id = ?')
    .get(teamId);
  return row?.last_seed_id ?? '';
}

async function pullSeeds(url: string, token: string, after: string): Promise<RelaySeed[]> {
  const target = new URL('/seeds', url);
  if (after) target.searchParams.set('after', after);
  const res = await fetch(target, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`relay responded ${res.status}`);
  return RelaySeedListSchema.parse(await res.json()).seeds;
}

function advanceCursor(ctx: Ctx, teamId: string, relayId: string, now: number): void {
  ctx.db
    .prepare(
      `INSERT INTO seeds_ingest_cursor (team_id, last_seed_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(team_id) DO UPDATE SET last_seed_id = excluded.last_seed_id, updated_at = excluded.updated_at`,
    )
    .run(teamId, relayId, now);
}

/** One team's ingest pass: pull everything past the cursor, create one shared Seed per record. Exported for
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

  const seeds = await pullSeeds(url, token, lastSeedId(ctx, team.id));
  let created = 0;
  for (const seed of seeds) {
    const tx = ctx.db.transaction(() => {
      const prior = ctx.db
        .prepare<
          [string, string],
          { id: string }
        >('SELECT id FROM seeds WHERE team_id = ? AND relay_id = ?')
        .get(team.id, seed.id);
      if (prior) {
        advanceCursor(ctx, team.id, seed.id, now);
        return false;
      }
      try {
        const stored = createSeedFromRelay(ctx.db, team.id, seed, now);
        advanceCursor(ctx, team.id, seed.id, now);
        appendAudit(ctx.db, team.id, {
          actor: stored.submitted_by,
          action: 'seed.ingested',
          target: stored.id,
          result: 'allow',
          detail: { seed_id: seed.id, source: seed.source },
        });
        return true;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'unknown_submitter') throw error;
        advanceCursor(ctx, team.id, seed.id, now);
        appendAudit(ctx.db, team.id, {
          actor: null,
          action: 'seed.ingested',
          target: seed.id,
          result: 'deny',
          detail: { seed_id: seed.id, source: seed.source, reason: 'unknown_submitter' },
        });
        return false;
      }
    });
    if (tx()) created += 1;
  }
  return created;
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
          const created = await ingestTeamSeeds(ctx, team);
          if (created > 0) log.info({ msg: 'seeds_ingested', team: team.slug, created });
        } catch (error) {
          // Offline is the expected failure mode (that is why the relay buffers); log and retry
          // next tick. Nothing is lost: the cursor did not move past a rejected source.
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
