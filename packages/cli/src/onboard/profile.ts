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
 * different domain (ADR 272).
 *
 * Phase 1 (this build) acts on `tools.mcp_servers` (provisioned via the harness's own CLI) and
 * `charter` (injected into AGENTS.md). `resource_scopes` are DECLARED-only (coordination, not a
 * sandbox — ADR 026 §1/§4); `tools.permissions` compile into the harness permission layer (ADR 261).
 *
 * Profile is not (yet) a wire type — these types live in the CLI until the v0.3 governance gate
 * lands.
 *
 * Back-compat (the rename is read-compatible, never write-legacy): a profile authored pre-rename
 * names itself with a `role` key and lives in `.musterd/roles/<name>.json` — both still load; new
 * files are written `profile`-keyed into `.musterd/profiles/`.
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

/** Pre-rename files name themselves with a `role` key; adopt it as `profile` when absent. */
function adoptLegacyRoleKey(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'role' in raw && !('profile' in raw)) {
    const { role, ...rest } = raw as Record<string, unknown>;
    return { ...rest, profile: role };
  }
  return raw;
}

export const ProfileSchema = z.preprocess(
  adoptLegacyRoleKey,
  z.object({
    profile: z.string().min(1),
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

/** Where a project's user-authored profiles live: `.musterd/profiles/<name>.json`. */
export function userProfilesDir(dir: string): string {
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
 * Load a profile by name for `dir`. A user file wins over a built-in of the same name
 * (customization); `.musterd/profiles/<name>.json` wins over the legacy `.musterd/roles/<name>.json`.
 * Throws a friendly Error if the file is missing or invalid.
 */
export function loadProfile(dir: string, name: string): Profile {
  for (const home of [userProfilesDir(dir), legacyUserRolesDir(dir)]) {
    const path = join(home, `${name}.json`);
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read profile ${name} (${path}): ${(err as Error).message}`);
    }
    try {
      return parseProfile(raw);
    } catch (err) {
      throw new Error(`profile ${name} (${path}) is invalid: ${zodMessage(err)}`);
    }
  }
  const builtin = BUILTIN_PROFILES[name];
  if (builtin) return builtin;
  throw new Error(
    `unknown profile "${name}" (no built-in and no .musterd/profiles/${name}.json — nor a legacy .musterd/roles/${name}.json)`,
  );
}

/**
 * List profile names available for `dir`: built-ins ∪ user files in `.musterd/profiles/*.json` ∪
 * legacy `.musterd/roles/*.json`. `generalist` is always first (the default). De-duplicated; user
 * files don't double-list a built-in.
 */
export function listProfileNames(dir: string): string[] {
  const names = new Set<string>(Object.keys(BUILTIN_PROFILES));
  for (const home of [userProfilesDir(dir), legacyUserRolesDir(dir)]) {
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

/** Is this profile name a built-in (vs. a user-authored file)? Used only for UI hints. */
export function isBuiltin(name: string): boolean {
  return name in BUILTIN_PROFILES;
}

/**
 * Derive an agent's roster/primer **role label** from the profile that provisions its tools,
 * so the label you see always matches the tooling you got (provisioning-recipe.md §1 "two
 * projections"; ADR 038). Precedence: an **explicit free-text override wins**; otherwise the
 * **chosen profile's name** drives it; otherwise **empty** (generalist / no profile — labelling
 * is opt-in, the ADR 028 default-nothing posture). Pure + side-effect-free so the interactive init
 * flow stays a thin caller (hard-to-test `@clack` prompts kept out of the logic).
 * (Increment 2 of the ADR 272 migration decouples the label from the profile; until then the
 * coupling is deliberate and unchanged.)
 */
export function resolveRoleLabel(opts: {
  template?: Profile | undefined;
  freeText?: string | undefined;
}): string {
  const explicit = opts.freeText?.trim();
  if (explicit) return explicit;
  return opts.template?.profile ?? '';
}

function zodMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  return (err as Error).message;
}
