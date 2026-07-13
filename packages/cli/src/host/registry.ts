import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * The machine-local host registry (ADR 131 §1): seat → workspace path + harness, one file per
 * machine. This is the store the daemon must never hold — it maps seats to filesystem paths so
 * `musterd host` can spawn a harness *in the seat's worktree*, and paths are a per-machine fact
 * (contract doc §1's three-stores table). Written by `musterd residency on` (run in the seat's
 * workspace), reversed by `residency off`, cross-checked by `residency status`.
 *
 * No secrets live here: the team agent key and the seat's standing grant stay in each workspace's
 * `.musterd/binding.json` — the host reads them *through* the workspace, never centrally.
 */

export const HostRegistryEntrySchema = z.object({
  /** The daemon this seat's team lives on (bindings can point at different servers). */
  server: z.string(),
  team: z.string(),
  seat: z.string(),
  /** Absolute path of the seat's workspace (worktree) — where the wake spawns. */
  workspace: z.string(),
  /** Harness class (`claude-code`, …) — selects the ActuatorBackend. */
  harness: z.string(),
  /** The host label this seat is enrolled under server-side. Stored so the poll asks for exactly
   *  the enrolled label — `hostname()` drifts across networks (mac.lan vs mac.local) and a drifted
   *  label would silently derive nothing. */
  host: z.string(),
  updated_at: z.number().int(),
});
export type HostRegistryEntry = z.infer<typeof HostRegistryEntrySchema>;

const HostRegistrySchema = z.object({
  entries: z.array(HostRegistryEntrySchema).default([]),
});
export type HostRegistry = z.infer<typeof HostRegistrySchema>;

/** `~/.musterd/host-registry.json`; `MUSTERD_HOST_REGISTRY` overrides (tests, odd setups). */
export function hostRegistryPath(): string {
  return process.env['MUSTERD_HOST_REGISTRY'] ?? join(homedir(), '.musterd', 'host-registry.json');
}

/** Load the registry; missing or malformed reads as empty (the registry is rebuildable by
 *  re-running `residency on` in each workspace — never worth a hard failure). */
export function loadHostRegistry(path = hostRegistryPath()): HostRegistry {
  try {
    const parsed = HostRegistrySchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

export function saveHostRegistry(registry: HostRegistry, path = hostRegistryPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

const sameSeat = (a: { server?: string; team: string; seat: string }, b: HostRegistryEntry) =>
  (a.server === undefined || a.server === b.server) && a.team === b.team && a.seat === b.seat;

/** Upsert keyed on (server, team, seat) — one workspace per seat per machine, last-write-wins
 *  (mirroring the server's last-enrolled-wins). Returns the saved entry. */
export function upsertHostEntry(
  entry: Omit<HostRegistryEntry, 'updated_at'>,
  path = hostRegistryPath(),
): HostRegistryEntry {
  const registry = loadHostRegistry(path);
  const full: HostRegistryEntry = { ...entry, updated_at: Date.now() };
  const rest = registry.entries.filter((e) => !sameSeat(entry, e));
  saveHostRegistry({ entries: [...rest, full] }, path);
  return full;
}

/** Remove a seat's entry (the `residency off` reversal). `server` optional: an `off` run outside
 *  the workspace has no binding to read it from — (team, seat) is unambiguous per machine anyway.
 *  Returns true when something was removed. */
export function removeHostEntry(
  key: { server?: string; team: string; seat: string },
  path = hostRegistryPath(),
): boolean {
  const registry = loadHostRegistry(path);
  const rest = registry.entries.filter((e) => !sameSeat(key, e));
  if (rest.length === registry.entries.length) return false;
  saveHostRegistry({ entries: rest }, path);
  return true;
}
