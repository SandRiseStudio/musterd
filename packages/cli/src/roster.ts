import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Lifecycle, type MemberKind, type SeatFile, serializeSeat } from '@musterd/protocol';

/**
 * Writing durable seat files (ADR 058 §5: the file is the single writer). Shared by `team add`,
 * `claim`, and `team export` so every seat that lands on disk is canonical from birth. A seat file is
 * only written when the team is *file-backed* (its slug is in `config.rosterHome`) — the writer's
 * caller gates on that; a db-only team keeps the legacy originate path untouched.
 */

export interface SeatFields {
  kind: MemberKind;
  role?: string | undefined;
  lifecycle?: Lifecycle | undefined;
  /** ISO-8601 or any Date-parseable string; normalized to canonical ISO on write. */
  until?: string | undefined;
}

/** Build a canonical {@link SeatFile} body from CLI inputs (drops `lifecycle`/`until` when forever). */
export function buildSeat(fields: SeatFields): SeatFile {
  const seat: SeatFile = { kind: fields.kind, role: fields.role ?? '' };
  if (fields.lifecycle && fields.lifecycle !== 'forever') {
    seat.lifecycle = fields.lifecycle;
    if (fields.lifecycle === 'until' && fields.until) {
      seat.until = new Date(fields.until).toISOString();
    }
  }
  return seat;
}

export function seatsDir(home: string): string {
  return join(home, '.musterd', 'seats');
}

export function seatFilePath(home: string, name: string): string {
  return join(seatsDir(home), `${name}.toml`);
}

export function seatFileExists(home: string, name: string): boolean {
  return existsSync(seatFilePath(home, name));
}

/** Write `seats/<name>.toml` (canonical) under a roster home, creating `seats/` as needed. */
export function writeSeatFile(home: string, name: string, fields: SeatFields): string {
  mkdirSync(seatsDir(home), { recursive: true });
  const p = seatFilePath(home, name);
  writeFileSync(p, serializeSeat(buildSeat(fields)), 'utf8');
  return p;
}
