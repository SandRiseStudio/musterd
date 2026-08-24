import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_DIR } from '@musterd/protocol';
import { z } from 'zod';
import { BUILTIN_PROFILE_TEMPLATES } from './profiles/builtins.js';

/**
 * A workspace **profile** is a harness-agnostic *provisioning template* (ADR 026 as renamed by
 * ADR 272; docs/design/provisioning-recipe.md §1 — "role template" pre-rename). It is authored once
 * and projects into two places at use-time: the identity half (role label, capacity, charter — the
 * SERVER record, v0.3-gated and NOT built here) and the harness half (`tools` — MCP servers,
 * declared scopes, permission defaults — which the local adapter PROVISIONS, additively, into THIS
 * machine's harness). This module owns the Universe-2 half: parse + load a profile, and the shipped
 * built-in seed library. A profile carries no authority — the roster role is a team fact in a
 * different domain, the label is never derived from a profile, and a profile's `charter` field is
 * legacy-descriptive: the primer's charter comes from the team role library (ADR 272 inc 2).
 *
 * What provisioning acts on: `tools.mcp_servers` (provisioned via the harness's own CLI) and
 * `tools.permissions` (compiled into the harness permission layer, ADR 261). `resource_scopes` are
 * DECLARED-only (coordination, not a sandbox — ADR 026 §1/§4).
 *
 * Profile is not (yet) a wire type — these types live in the CLI until the v0.3 governance gate
 * lands.
 *
 * Back-compat (each rename is read-compatible, never write-legacy). The concept has been named
 * three times, and all three on-disk shapes still load: `role`-keyed in `.musterd/roles/` (pre-ADR
 * 272), `profile`-keyed in `.musterd/profiles/` (pre-ADR 296), and the canonical `toolkit`-keyed
 * file in `.musterd/toolkits/`, which is the only shape ever written (ADR 296 tier 2).
 */

/** A concrete MCP server entry inside a profile's `tools.mcp_servers`. Secrets are `${ENV}` refs. */
export const ProfileMcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});
export type ProfileMcpServer = z.infer<typeof ProfileMcpServerSchema>;

/** Harness permission defaults, compiled into the harness permission layer (ADR 261). */
export const ProfilePermissionsSchema = z
  .object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .default({ allow: [], ask: [], deny: [] });

export const ProfileToolsSchema = z
  .object({
    mcp_servers: z.array(ProfileMcpServerSchema).default([]),
    resource_scopes: z.array(z.string()).default([]),
    permissions: ProfilePermissionsSchema,
  })
  .default({});

/**
 * The charter — the *lens*, not a résumé (human-agent-dynamics.md §3). Authored as a string or an
 * array of lines (friendlier for multi-line prose in JSON); normalized to a single string.
 */
const CharterSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v.join('\n') : v))
  .refine((v) => v.trim().length > 0, { message: 'charter must not be empty' });

/**
 * The name key has been renamed twice, and both older spellings still load (ADR 296 tier 2 —
 * legacy accepted on read, never written): `role` pre-ADR-272, `profile` pre-ADR-296. A file
 * carrying more than one wins on the newest it has, so a hand-merged file never silently adopts
 * the oldest name.
 */
function adoptLegacyToolkitKey(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || 'toolkit' in raw) return raw;
  const rec = raw as Record<string, unknown>;
  for (const legacy of ['profile', 'role'] as const) {
    if (legacy in rec) {
      const { [legacy]: value, ...rest } = rec;
      return { ...rest, toolkit: value };
    }
  }
  return raw;
}

export const ProfileSchema = z.preprocess(
  adoptLegacyToolkitKey,
  z.object({
    toolkit: z.string().min(1),
    capacity: z.number().int().positive().optional(),
    charter: CharterSchema,
    tools: ProfileToolsSchema,
  }),
);
export type Profile = z.infer<typeof ProfileSchema>;

/** The no-extra-tooling default: only the musterd server + a bare charter (ADR 028). */
export const GENERALIST = 'generalist';

/** Parse + validate an unknown value as a profile (hard rule #4 — zod at the boundary). */
export function parseProfile(raw: unknown): Profile {
  return ProfileSchema.parse(raw);
}

/** The validated built-in seed library, keyed by profile name (raw data: `profiles/builtins.ts`). */
export const BUILTIN_PROFILES: Record<string, Profile> = Object.fromEntries(
  Object.entries(BUILTIN_PROFILE_TEMPLATES).map(([name, raw]) => [name, parseProfile(raw)]),
);

/** Where a project's user-authored toolkits live: `.musterd/toolkits/<name>.json`. */
export function userToolkitsDir(dir: string): string {
  return join(dir, BINDING_DIR, 'toolkits');
}

/**
 * The ADR 272 home, `.musterd/profiles/` — still read, never written, like the `roles/` home
 * before it. Only `*.json` files here are toolkits.
 */
export function legacyUserProfilesDir(dir: string): string {
  return join(dir, BINDING_DIR, 'profiles');
}

/**
 * The pre-rename home, `.musterd/roles/` — still read (never written) so existing setups keep
 * working. The dir is shared with the roster-role TOML library (`roles/<name>.toml`), which is a
 * different concept and untouched by profiles: only `*.json` files here are profiles.
 */
export function legacyUserRolesDir(dir: string): string {
  return join(dir, BINDING_DIR, 'roles');
}

/**
 * Where a toolkit may live, newest home first: the canonical `.musterd/toolkits/`, then the two
 * older homes, which are read and never written. One list, so the loader and the lister can never
 * disagree about which files exist.
 */
const TOOLKIT_HOMES = [userToolkitsDir, legacyUserProfilesDir, legacyUserRolesDir] as const;

/**
 * The toolkit search path for `dir`, newest home first — the one list every reader walks. Callers
 * outside this module use it instead of naming the homes themselves, so adding or retiring a home
 * is one edit and no caller silently keeps the old set.
 */
export function toolkitHomes(dir: string): string[] {
  return TOOLKIT_HOMES.map((home) => home(dir));
}

/**
 * Load a profile by name for `dir`. A user file wins over a built-in of the same name
 * (customization), and the newest home wins over the older ones ({@link toolkitHomes}).
 * Throws a friendly Error if the file is missing or invalid.
 */
export function loadProfile(dir: string, name: string): Profile {
  for (const home of toolkitHomes(dir)) {
    const path = join(home, `${name}.json`);
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read toolkit ${name} (${path}): ${(err as Error).message}`);
    }
    try {
      return parseProfile(raw);
    } catch (err) {
      throw new Error(`toolkit ${name} (${path}) is invalid: ${zodMessage(err)}`);
    }
  }
  const builtin = BUILTIN_PROFILES[name];
  if (builtin) return builtin;
  throw new Error(
    `unknown toolkit "${name}" (no built-in and no .musterd/toolkits/${name}.json — nor a legacy .musterd/profiles/ or .musterd/roles/ file of that name)`,
  );
}

/**
 * List toolkit names available for `dir`: built-ins ∪ user files in every home in
 * {@link TOOLKIT_HOMES}. `generalist` is always first (the default). De-duplicated; user files
 * don't double-list a built-in.
 */
export function listProfileNames(dir: string): string[] {
  const names = new Set<string>(Object.keys(BUILTIN_PROFILES));
  for (const home of toolkitHomes(dir)) {
    try {
      for (const f of readdirSync(home)) {
        if (f.endsWith('.json')) names.add(f.slice(0, -'.json'.length));
      }
    } catch {
      // dir absent — skip
    }
  }
  const rest = [...names].filter((n) => n !== GENERALIST).sort();
  return [GENERALIST, ...rest];
}

/** Is this toolkit name a built-in (vs. a user-authored file)? Used only for UI hints. */
export function isBuiltin(name: string): boolean {
  return name in BUILTIN_PROFILES;
}

function zodMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  return (err as Error).message;
}
