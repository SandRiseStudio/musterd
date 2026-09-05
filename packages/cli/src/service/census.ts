/**
 * ADR 232 increment 2 — the census check: musterd-labeled LaunchAgents vs roster service seats.
 * Pure: callers pass the jobs they found and the service seats they read. Warn-only.
 *
 * Increment 3 (lane 01M1Q9D90XEP9FPCYPQNBFH73Q, 2026-09-04): the job-gone set is DERIVED from the
 * roster — every `kind: service` seat holding the `platform` role — never a literal. The literal
 * this replaced froze four labels on 2026-08-12; `guardian` and `streamwatch` shipped afterwards as
 * platform seats with live jobs and were outside it, so either could lose its LaunchAgent in total
 * silence — and guardian is the daemon watchdog. A check keyed to a literal degrades every time the
 * population it describes grows; deriving it is the only repair that does not need re-applying.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HttpClient } from '../client.js';
import { findBinding } from '../config.js';
import { SERVICE_LABEL, parsePlistLabel, serviceSupported } from './launchd.js';

const LABEL_PREFIX = `${SERVICE_LABEL}-`;

/** The role that makes a service seat's LaunchAgent expected on this machine (ADR 232 §6). */
export const PLATFORM_ROLE = 'platform';

export interface CensusJob {
  label: string;
  /**
   * A dated one-shot — `StartCalendarInterval` naming a Month and Day, with no `StartInterval`.
   * It fires once and has no standing presence to attribute, so it is not an unattributed ACTOR;
   * it is a task, and it is named as one (and named again once it has fired and is still installed).
   */
  oneShot?: { month: number; day: number } | undefined;
}

export interface CensusSeat {
  name: string;
  roles: string[];
}

function seatForLabel(label: string): string | null {
  if (!label.startsWith(LABEL_PREFIX)) return null;
  return label.slice(LABEL_PREFIX.length);
}

/** `MM-DD` for the note — the plist carries no year, so neither does this. */
function fireDate(o: { month: number; day: number }): string {
  return `${String(o.month).padStart(2, '0')}-${String(o.day).padStart(2, '0')}`;
}

/** Has this year's firing of a Month+Day one-shot already passed? (`now` is UTC ms.) */
function alreadyFired(o: { month: number; day: number }, now: number): boolean {
  const d = new Date(now);
  const fire = Date.UTC(d.getUTCFullYear(), o.month - 1, o.day, 23, 59, 59);
  return now > fire;
}

export function censusNotes(input: {
  jobs: CensusJob[];
  seats: CensusSeat[];
  /** Injected for the one-shot notes; defaults to the wall clock. */
  now?: number;
}): string[] {
  const now = input.now ?? Date.now();
  const seatNames = new Set(input.seats.map((s) => s.name));
  const jobLabels = new Set(input.jobs.map((j) => j.label));
  const notes: string[] = [];

  for (const j of input.jobs) {
    const seat = seatForLabel(j.label);
    if (seat === null) continue;
    if (seatNames.has(seat)) continue;
    if (j.oneShot) {
      notes.push(
        alreadyFired(j.oneShot, now)
          ? `LaunchAgent ${j.label} is a one-shot task that already fired (${fireDate(j.oneShot)}) and is still installed — remove it (ADR 232).`
          : `LaunchAgent ${j.label} is a dated one-shot task (fires ${fireDate(j.oneShot)}), not a service — no seat expected (ADR 232).`,
      );
      continue;
    }
    notes.push(`LaunchAgent ${j.label} has no service seat — an unattributed actor (ADR 232).`);
  }

  // "Job gone" applies to every PLATFORM service seat — the set the roster says, read fresh each
  // check. A project-service seat (deploybot) is not a missing LaunchAgent.
  for (const s of input.seats) {
    if (!s.roles.includes(PLATFORM_ROLE)) continue;
    if (jobLabels.has(`${LABEL_PREFIX}${s.name}`)) continue;
    notes.push(`service seat "${s.name}" has no LaunchAgent — its job is gone (ADR 232).`);
  }
  return notes;
}

/** Default macOS user LaunchAgents directory. */
export function defaultAgentsDir(): string {
  return join(homedir(), 'Library', 'LaunchAgents');
}

/**
 * A dated one-shot's schedule, or null for anything that recurs. Recognised by shape, not by name:
 * `StartCalendarInterval` with BOTH a Month and a Day and no `StartInterval`. A calendar job with
 * only Hour/Minute recurs daily and is a service; an interval job is a service.
 */
export function parsePlistOneShot(xml: string): { month: number; day: number } | null {
  if (/<key>StartInterval<\/key>/.test(xml)) return null;
  const block = xml.match(/<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!block) return null;
  const month = block[1]!.match(/<key>Month<\/key>\s*<integer>(\d+)<\/integer>/);
  const day = block[1]!.match(/<key>Day<\/key>\s*<integer>(\d+)<\/integer>/);
  if (!month || !day) return null;
  return { month: Number(month[1]), day: Number(day[1]) };
}

/**
 * Read every `.plist` in `agentsDir` and return its `Label` plus what its schedule says about it.
 * Filename is not identity — hand-authored plists walk past `service install`. Missing dir /
 * garbage files are skipped. Sorted by label so the notes are stable.
 */
export function listCensusJobs(agentsDir: string): CensusJob[] {
  let names: string[];
  try {
    names = readdirSync(agentsDir);
  } catch {
    return [];
  }
  const jobs: CensusJob[] = [];
  for (const name of names) {
    if (!name.endsWith('.plist')) continue;
    try {
      const xml = readFileSync(join(agentsDir, name), 'utf8');
      const label = parsePlistLabel(xml);
      if (!label) continue;
      const oneShot = parsePlistOneShot(xml);
      jobs.push(oneShot ? { label, oneShot } : { label });
    } catch {
      /* unreadable — skip, never invent a job */
    }
  }
  return jobs.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** Labels only — the increment-2 surface, kept for callers that want nothing else. */
export function listCensusLabels(agentsDir: string): string[] {
  return listCensusJobs(agentsDir).map((j) => j.label);
}

/** What the census needs from a roster row. `roles` is authoritative; `role` is the display
 *  label an older daemon may be the only one to send (ADR 227 back-compat). */
export interface CensusMember {
  name: string;
  kind: string;
  role?: string | undefined;
  roles?: string[] | undefined;
}

function seatRoles(m: CensusMember): string[] {
  if (m.roles !== undefined && m.roles.length > 0) return m.roles;
  return m.role ? [m.role] : [];
}

export async function inspectCensus(deps?: {
  agentsDir?: string;
  members?: CensusMember[];
  platform?: NodeJS.Platform;
  cwd?: string;
  now?: number;
  fetchMembers?: () => Promise<CensusMember[] | undefined>;
}): Promise<string[]> {
  if (!serviceSupported(deps?.platform ?? process.platform)) return [];
  const fetchMembers =
    deps?.fetchMembers ??
    (async () => {
      const binding = findBinding(deps?.cwd ?? process.cwd());
      if (!binding?.server || !binding.team) return undefined;
      try {
        const { members } = await new HttpClient({ server: binding.server }).roster(binding.team);
        return members;
      } catch {
        return undefined;
      }
    });
  const members = deps?.members ?? (await fetchMembers().catch(() => undefined));
  if (!members) return [];
  const jobs = listCensusJobs(deps?.agentsDir ?? defaultAgentsDir());
  const seats = members
    .filter((m) => m.kind === 'service')
    .map((m) => ({ name: m.name, roles: seatRoles(m) }));
  return censusNotes({ jobs, seats, ...(deps?.now !== undefined ? { now: deps.now } : {}) });
}
