/**
 * ADR 232 increment 2 — the census check: musterd-labeled LaunchAgents vs roster service seats.
 * Pure: callers pass the labels they found and the service seat names they read. Warn-only.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HttpClient } from '../client.js';
import { findBinding } from '../config.js';
import {
  AUTOREFRESH_LABEL,
  HOST_LABEL,
  LIVE_LABEL,
  SERVICE_LABEL,
  SWEEP_LABEL,
  parsePlistLabel,
  serviceSupported,
} from './launchd.js';

const LABEL_PREFIX = `${SERVICE_LABEL}-`;

/**
 * "Job gone" only applies to these — a project-service seat (deploybot) is not a missing LaunchAgent.
 *
 * THIS LIST IS KNOWN INCOMPLETE and that is the defect, not the design (measured 2026-09-04).
 * `guardian` and `streamwatch` shipped after ADR 232 froze these four; both are `kind: service,
 * role: platform` seats with live LaunchAgents, and both are absent here. Because the loop below
 * iterates the literal rather than the roster, either can lose its job in total silence — and
 * guardian is the daemon watchdog. Lane 01M1Q9D90XEP9FPCYPQNBFH73Q derives this set from the roster.
 * Do not quietly append to the literal: an appended name fixes one seat and leaves the next one to
 * be discovered the same way.
 */
const PLATFORM_SERVICE_LABELS = [AUTOREFRESH_LABEL, HOST_LABEL, LIVE_LABEL, SWEEP_LABEL] as const;

function seatForLabel(label: string): string | null {
  if (!label.startsWith(LABEL_PREFIX)) return null;
  return label.slice(LABEL_PREFIX.length);
}

export function censusNotes(input: { labels: string[]; serviceSeats: string[] }): string[] {
  const seats = new Set(input.serviceSeats);
  const jobs = new Set(input.labels);
  const notes: string[] = [];
  for (const label of input.labels) {
    const seat = seatForLabel(label);
    if (seat === null) continue;
    if (seats.has(seat)) continue;
    notes.push(`LaunchAgent ${label} has no service seat — an unattributed actor (ADR 232).`);
  }
  for (const label of PLATFORM_SERVICE_LABELS) {
    const seat = seatForLabel(label);
    if (seat === null || !seats.has(seat) || jobs.has(label)) continue;
    notes.push(`service seat "${seat}" has no LaunchAgent — its job is gone (ADR 232).`);
  }
  return notes;
}

/** Default macOS user LaunchAgents directory. */
export function defaultAgentsDir(): string {
  return join(homedir(), 'Library', 'LaunchAgents');
}

/**
 * Read every `.plist` in `agentsDir` and return its `Label`. Filename is not identity —
 * hand-authored plists walk past `service install`. Missing dir / garbage files are skipped.
 */
export function listCensusLabels(agentsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(agentsDir);
  } catch {
    return [];
  }
  const labels: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.plist')) continue;
    try {
      const label = parsePlistLabel(readFileSync(join(agentsDir, name), 'utf8'));
      if (label) labels.push(label);
    } catch {
      /* unreadable — skip, never invent a job */
    }
  }
  return labels.sort();
}

export async function inspectCensus(deps?: {
  agentsDir?: string;
  members?: { name: string; kind: string }[];
  platform?: NodeJS.Platform;
  cwd?: string;
  fetchMembers?: () => Promise<{ name: string; kind: string }[] | undefined>;
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
  const labels = listCensusLabels(deps?.agentsDir ?? defaultAgentsDir());
  const serviceSeats = members.filter((m) => m.kind === 'service').map((m) => m.name);
  return censusNotes({ labels, serviceSeats });
}
