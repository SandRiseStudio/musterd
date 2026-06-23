import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_DIR } from '@musterd/protocol';
import { z } from 'zod';

/**
 * The provisioning manifest (ADR 030) — musterd's record of what it provisioned into *this* folder's
 * harness, so it can be removed *exactly* later. This closes ADR 027's reversibility gap: today's
 * `musterd reset` wipes the db + config but leaves harness footprint behind. A future per-folder
 * `musterd uninstall` reads this file to `claude mcp remove` precisely the server names musterd
 * added — never clobbering the user's own servers.
 *
 * It lives at `.musterd/provisioned.json` (next to `binding.json`). It carries **no secrets** —
 * only the server *names* musterd registered (the values stay `${ENV}` refs in the harness config),
 * so unlike `binding.json` it is safe to leave un-gitignored. Server names accumulate across
 * re-provisions (union) so the manifest stays a complete removal set.
 */
export const PROVISION_MANIFEST_FILE = 'provisioned.json';

const PermissionsSchema = z
  .object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .default({ allow: [], ask: [], deny: [] });

export const ProvisionManifestSchema = z.object({
  version: z.literal(1),
  role: z.string(),
  harness: z.string(),
  /** MCP server names musterd registered into the harness (removable exactly). */
  mcpServers: z.array(z.string()),
  /** Permission entries musterd added to the harness's allow/ask/deny (removable exactly). */
  permissions: PermissionsSchema,
  /** ISO timestamp of the most recent provision. */
  provisionedAt: z.string(),
});
export type ProvisionManifest = z.infer<typeof ProvisionManifestSchema>;

function manifestPath(dir: string): string {
  return join(dir, BINDING_DIR, PROVISION_MANIFEST_FILE);
}

/** Read + validate the manifest for `dir`, or null if absent/unreadable/invalid. */
export function readProvisionManifest(dir: string): ProvisionManifest | null {
  const path = manifestPath(dir);
  if (!existsSync(path)) return null;
  try {
    return ProvisionManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Record a provision into `<dir>/.musterd/provisioned.json`. Server names are unioned with any
 * already recorded (so re-provisioning a second role keeps the first role's servers removable);
 * `role`/`harness`/`provisionedAt` reflect the latest provision. Returns the written path.
 */
export function writeProvisionManifest(
  dir: string,
  entry: {
    role: string;
    harness: string;
    mcpServers: string[];
    permissions?: { allow: string[]; ask: string[]; deny: string[] };
  },
): string {
  const prior = readProvisionManifest(dir);
  const merged = new Set<string>([...(prior?.mcpServers ?? []), ...entry.mcpServers]);
  const mergePerm = (list: 'allow' | 'ask' | 'deny') =>
    [
      ...new Set([...(prior?.permissions[list] ?? []), ...(entry.permissions?.[list] ?? [])]),
    ].sort();
  const manifest: ProvisionManifest = {
    version: 1,
    role: entry.role,
    harness: entry.harness,
    mcpServers: [...merged].sort(),
    permissions: { allow: mergePerm('allow'), ask: mergePerm('ask'), deny: mergePerm('deny') },
    provisionedAt: new Date().toISOString(),
  };
  const bindingDir = join(dir, BINDING_DIR);
  mkdirSync(bindingDir, { recursive: true });
  const path = manifestPath(dir);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return path;
}
