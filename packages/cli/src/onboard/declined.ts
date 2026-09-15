import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Recorded refusals — the ADR 332 tombstone.
 *
 * musterd's provisioning has only ever had two states for a surface: **installed** and **absent**.
 * That is one state short. A user who deliberately removes the seat chip is indistinguishable from
 * one who never had it, so `init --check` prescribes the same repair forever and the human is
 * nagged for a choice they already made. Reporting a choice as drift trains people to ignore drift,
 * which costs more than the surface was ever worth.
 *
 * A tombstone is the third state: absence that was **chosen**. It is a machine-local preference, so
 * it lives beside the binding and never travels (ADR 259) — no team propagation, no reason field, no
 * expiry. What the file records is only: this surface, refused, when, by whom.
 *
 * Deliberately NOT in `binding.json`: that file is identity, and a re-claim rewrites it. A
 * preference must not depend on identity churn. Deliberately not in the harness's own settings
 * either — the hook table has the same shape as the chip, so the vocabulary has to outlive any one
 * harness's schema.
 */

/** Where refusals are recorded for a workspace. Sibling of `binding.json`, same directory. */
export function declinedPath(dir: string): string {
  return join(dir, '.musterd', 'declined.json');
}

/**
 * A refusable surface, named `<harness>:<slot>`. The harness prefix is load-bearing: a slot name
 * alone (`statusLine`, `PostToolUse`) is only unique inside one harness, and a folder can be
 * provisioned for several.
 */
export type SurfaceName = string;

export interface Tombstone {
  surface: SurfaceName;
  /** ISO 8601, for the line `init --refresh-hooks` prints when it resurrects one. */
  at: string;
  /** Who refused. Free text — this is a local note, not an identity claim. */
  by?: string;
}

interface DeclinedFile {
  version: 1;
  declined: Tombstone[];
}

/**
 * Every refusal recorded for this workspace.
 *
 * An unreadable or malformed file yields **no refusals**, never a thrown error and never an invented
 * one: the same discipline `readSettingsSafe` applies one directory over. The asymmetry is
 * deliberate — failing open here means a surface the user declined might come back, which is
 * recoverable and visible. Failing closed would mean a surface silently missing with no record of
 * why, which is the defect this ADR exists to end.
 */
export function readDeclined(dir: string): Tombstone[] {
  const path = declinedPath(dir);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return [];
    const list = (parsed as Partial<DeclinedFile>).declined;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (t): t is Tombstone =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as Tombstone).surface === 'string' &&
        typeof (t as Tombstone).at === 'string',
    );
  } catch {
    return [];
  }
}

/** Is this surface refused here? The one question every drift inspector asks. */
export function isDeclined(dir: string, surface: SurfaceName): boolean {
  return readDeclined(dir).some((t) => t.surface === surface);
}

/**
 * Record a refusal. Idempotent — declining an already-declined surface keeps the ORIGINAL date, so
 * the `at` a resurrection line prints is when the user actually decided, not when they last typed
 * the command. Returns false when the tombstone was already there.
 */
export function declineSurface(dir: string, surface: SurfaceName, by?: string): boolean {
  const declined = readDeclined(dir);
  if (declined.some((t) => t.surface === surface)) return false;
  declined.push({ surface, at: new Date().toISOString(), ...(by ? { by } : {}) });
  writeDeclined(dir, declined);
  return true;
}

/**
 * Clear a refusal, returning the tombstone that was removed (so a caller can name the date in the
 * line it prints) or undefined when there was none. Resurrection is never silent: a surface coming
 * back with no explanation is how a user finds the chip returned and has no idea why.
 */
export function acceptSurface(dir: string, surface: SurfaceName): Tombstone | undefined {
  const declined = readDeclined(dir);
  const found = declined.find((t) => t.surface === surface);
  if (!found) return undefined;
  writeDeclined(
    dir,
    declined.filter((t) => t.surface !== surface),
  );
  return found;
}

function writeDeclined(dir: string, declined: Tombstone[]): void {
  const path = declinedPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const body: DeclinedFile = { version: 1, declined };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n', 'utf8');
}
