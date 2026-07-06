import type { MemoryEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { MusterdError } from '../errors.js';

/**
 * Seat memory (ADR 093): a daemon-private, seat-scoped continuity blob — the working state a
 * returning occupant needs (what it was doing, decisions mid-flight, where it left off). One row per
 * member, last-write-wins, no history. The occupant writes it explicitly (`memory_save`); musterd
 * stores, never composes. Delivery is envelope-on-occupy / body-on-demand: {@link memoryEnvelope}
 * rides the occupied frame (headline + age + size, never the body); {@link getMemory} is the explicit
 * read. Lives in the daemon DB, never the git seat-file — half-done context (or secrets pasted into a
 * note) must not land in repo history (the ADR 058 durable/live line).
 */

/** Body cap in UTF-8 bytes — cheap per-session context, rejected above with the limit named. */
export const MEMORY_BODY_MAX_BYTES = 8192;
/** Headline cap in characters — the commit-subject convention that keeps the occupy line one line. */
export const MEMORY_HEADLINE_MAX_CHARS = 120;

export interface Memory {
  headline: string;
  body: string;
  saved_at: number;
}

interface MemoryRow {
  headline: string;
  body: string;
  saved_at: number;
}

/**
 * Save (upsert, last-write-wins) the seat's memory, stamping `saved_at`. Enforces both caps —
 * headline by character count, body by UTF-8 byte length — and rejects an oversize/empty input with
 * the limit named. Never logs or audits the content itself (sizes only; hard rule 5).
 */
export function saveMemory(
  db: Database,
  memberId: string,
  input: { headline: string; body: string },
): void {
  const headline = input.headline;
  if (headline.length < 1) {
    throw new MusterdError('bad_request', 'memory headline is required');
  }
  if (headline.length > MEMORY_HEADLINE_MAX_CHARS) {
    throw new MusterdError(
      'bad_request',
      `memory headline is ${headline.length} chars; the limit is ${MEMORY_HEADLINE_MAX_CHARS}`,
    );
  }
  const bodyBytes = Buffer.byteLength(input.body, 'utf8');
  if (bodyBytes > MEMORY_BODY_MAX_BYTES) {
    throw new MusterdError(
      'bad_request',
      `memory body is ${bodyBytes} bytes; the limit is ${MEMORY_BODY_MAX_BYTES}`,
    );
  }
  db.prepare(
    `INSERT INTO seat_memory (member_id, headline, body, saved_at)
       VALUES (@member_id, @headline, @body, @saved_at)
     ON CONFLICT(member_id) DO UPDATE SET
       headline = excluded.headline,
       body     = excluded.body,
       saved_at = excluded.saved_at`,
  ).run({ member_id: memberId, headline, body: input.body, saved_at: Date.now() });
}

/** The full note for a seat — the explicit body read — or null if nothing is saved. */
export function getMemory(db: Database, memberId: string): Memory | null {
  const row = db
    .prepare<
      [string],
      MemoryRow
    >('SELECT headline, body, saved_at FROM seat_memory WHERE member_id = ?')
    .get(memberId);
  return row ? { headline: row.headline, body: row.body, saved_at: row.saved_at } : null;
}

/**
 * The envelope that rides the occupied frame: headline + age + size, **never the body** (ADR 093 §3).
 * `size_bytes` is the UTF-8 byte length of the body so the agent sees the fetch cost.
 */
export function memoryEnvelope(db: Database, memberId: string): MemoryEnvelope | null {
  const row = db
    .prepare<
      [string],
      MemoryRow
    >('SELECT headline, body, saved_at FROM seat_memory WHERE member_id = ?')
    .get(memberId);
  if (!row) return null;
  return {
    headline: row.headline,
    saved_at: row.saved_at,
    size_bytes: Buffer.byteLength(row.body, 'utf8'),
  };
}

/** Clear the seat's memory. Returns true if a row existed (idempotent — false when already empty). */
export function clearMemory(db: Database, memberId: string): boolean {
  const info = db.prepare('DELETE FROM seat_memory WHERE member_id = ?').run(memberId);
  return info.changes > 0;
}
