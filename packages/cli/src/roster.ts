import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Lifecycle,
  type MemberKind,
  type SeatFile,
  parseSeatFile,
  serializeSeat,
} from '@musterd/protocol';
import { assignHue, defaultHue } from '@musterd/protocol/hue';

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
  /** The seat's colour (ADR 374). Undefined ⇒ assigned at write, clear of the sibling seat files. */
  hue?: number | undefined;
}

/** Build a canonical {@link SeatFile} body from CLI inputs (drops `lifecycle`/`until` when forever). */
export function buildSeat(fields: SeatFields): SeatFile {
  const seat: SeatFile = { kind: fields.kind, role: fields.role ?? '' };
  if (fields.hue !== undefined) seat.hue = fields.hue;
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

/**
 * Write `seats/<name>.toml` (canonical) under a roster home, creating `seats/` as needed.
 *
 * A seat lands on disk coloured (ADR 374): when the caller names no hue, one is assigned here from
 * the name's default, walked clear of every hue the sibling seat files already hold. The file is
 * the source of truth on a file-backed team, so this — not the daemon — is where the colour is
 * born, and it is born in a diff someone can read.
 */
export function writeSeatFile(home: string, name: string, fields: SeatFields): string {
  mkdirSync(seatsDir(home), { recursive: true });
  const p = seatFilePath(home, name);
  const hue = fields.hue ?? assignHue(defaultHue(name), Object.values(readSeatHues(home, name)));
  writeFileSync(p, serializeSeat(buildSeat({ ...fields, hue })), 'utf8');
  return p;
}

/** Every seat file under a roster home, parsed, keyed by seat name. */
export function readSeatFiles(home: string): Record<string, SeatFile> {
  const dir = seatsDir(home);
  if (!existsSync(dir)) return {};
  const out: Record<string, SeatFile> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.toml')) continue;
    const name = f.slice(0, -'.toml'.length);
    out[name] = parseSeatFile(readFileSync(join(dir, f), 'utf8'), name);
  }
  return out;
}

/** The hues the seat files hold, by name — `except` leaves one seat out of its own way. */
export function readSeatHues(home: string, except?: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, seat] of Object.entries(readSeatFiles(home))) {
    if (name !== except && seat.hue !== undefined) out[name] = seat.hue;
  }
  return out;
}

/** Set one seat file's hue in place (the `role.ts` edit idiom: parse → change → serialize). */
export function setSeatHue(home: string, name: string, hue: number): string {
  const p = seatFilePath(home, name);
  const seat = parseSeatFile(readFileSync(p, 'utf8'), name);
  writeFileSync(p, serializeSeat({ ...seat, hue }), 'utf8');
  return p;
}
