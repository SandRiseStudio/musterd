import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { machineStatePath } from '../machinePaths.js';

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
  return machineStatePath('MUSTERD_HOST_REGISTRY', 'host-registry.json');
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

/** Every spelling of the local loopback that a binding has been seen to carry. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/**
 * The registry's identity for a daemon (lane 01M1J2V4EJ, 2026-09-02). `server` is copied from a
 * workspace's `binding.json`, which a human typed — `localhost` in one, `127.0.0.1` in the next —
 * and the same socket under two spellings became two registry identities and two poll groups. The
 * first group to claim a lease for the other's seat then reported it "not in this machine's host
 * registry" while the seat WAS registered. Fold what cannot distinguish two daemons: case, the
 * trailing slash, and the loopback aliases. A remote host keeps its name; a value that is not a
 * URL is returned as given, so the loop still groups on it rather than dropping the entry.
 */
export function canonicalServer(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return server;
  }
  const host = url.hostname.toLowerCase();
  const canonicalHost =
    LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host) ? '127.0.0.1' : host;
  const port = url.port ? `:${url.port}` : '';
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol.toLowerCase()}//${canonicalHost}${port}${pathname}`;
}

const sameSeat = (a: { server?: string; team: string; seat: string }, b: HostRegistryEntry) =>
  (a.server === undefined || canonicalServer(a.server) === canonicalServer(b.server)) &&
  a.team === b.team &&
  a.seat === b.seat;

/** Upsert keyed on (server, team, seat) — one workspace per seat per machine, last-write-wins
 *  (mirroring the server's last-enrolled-wins). The server is stored canonical. Returns the saved
 *  entry. */
export function upsertHostEntry(
  entry: Omit<HostRegistryEntry, 'updated_at'>,
  path = hostRegistryPath(),
): HostRegistryEntry {
  const registry = loadHostRegistry(path);
  const full: HostRegistryEntry = {
    ...entry,
    server: canonicalServer(entry.server),
    updated_at: Date.now(),
  };
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
