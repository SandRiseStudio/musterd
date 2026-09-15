import type { InsightHit } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';

/**
 * Team memory retrieval (ADR 327) — the daemon's fold over the `insight` acts in the message log.
 * The FTS table (`insights_fts`, migration 46) is a derived, rebuildable cache: triggers keep it
 * current on insert/delete, `rebuildInsightsFts` can recreate it from the log alone, and nothing
 * lives only here (ADR 259). Under ADR 325 every replica daemon folds its own copy. Deliberately
 * named apart from `store/insights.ts` — that file is the ADR 050 coordination-insight *report*
 * engine; this one only searches saved findings.
 */

/** Default page size for `/memory/search`; the route clamps harder. */
export const INSIGHT_SEARCH_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Make user text safe for FTS5 MATCH: each whitespace token becomes a quoted term (implicit AND),
 * inner quotes doubled. A raw query would otherwise be FTS syntax and could error or surprise.
 */
export function ftsQuery(input: string): string {
  return input
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(' ');
}

interface SearchRow {
  id: string;
  name: string;
  headline: string | null;
  body: string;
  tags: string | null;
  ts: number;
}

/** Full-text search over the team's insight acts; relevance rank first, newest wins ties. */
export function searchInsights(
  db: Database,
  teamId: string,
  query: string,
  limit: number = INSIGHT_SEARCH_LIMIT,
): InsightHit[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const capped = Math.max(1, Math.min(Math.floor(limit) || INSIGHT_SEARCH_LIMIT, MAX_LIMIT));
  const rows = db
    .prepare<[string, string, number], SearchRow>(
      `SELECT m.id,
              mem.name    AS name,
              json_extract(m.meta, '$.headline') AS headline,
              m.body      AS body,
              json_extract(m.meta, '$.tags')     AS tags,
              m.ts        AS ts
       FROM insights_fts f
       JOIN messages m ON m.id = f.message_id
       JOIN members mem ON mem.id = m.from_member
       WHERE insights_fts MATCH ? AND f.team_id = ?
       ORDER BY rank, m.ts DESC
       LIMIT ?`,
    )
    .all(match, teamId, capped);
  return rows.map((r) => ({
    id: r.id,
    from: r.name,
    headline: r.headline ?? '',
    body: r.body,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    ts: r.ts,
  }));
}

/** Recreate the fold from the log alone — the property that makes it a cache, not a store. */
export function rebuildInsightsFts(db: Database): number {
  db.exec('DELETE FROM insights_fts');
  db.exec(`
    INSERT INTO insights_fts (message_id, team_id, headline, body, tags)
    SELECT m.id,
           m.team_id,
           COALESCE(json_extract(m.meta, '$.headline'), ''),
           m.body,
           COALESCE(json_extract(m.meta, '$.tags'), '')
    FROM messages m
    WHERE m.act = 'insight'
  `);
  const row = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM insights_fts').get();
  return row?.n ?? 0;
}
