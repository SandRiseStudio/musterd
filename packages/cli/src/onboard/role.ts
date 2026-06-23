import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_DIR } from '@musterd/protocol';
import { z } from 'zod';
import { BUILTIN_ROLE_TEMPLATES } from './roles/builtins.js';

/**
 * A Role is a harness-agnostic *provisioning template* (ADR 026, docs/design/provisioning-recipe.md
 * §1). It is authored once and projects into two places at use-time: the identity half (role,
 * capacity, charter — the SERVER record, v0.3-gated and NOT built here) and the harness half
 * (`tools` — MCP servers, declared scopes, permission defaults — which the local adapter PROVISIONS,
 * additively, into THIS machine's harness). This module owns the Universe-2 half: parse + load a
 * template, and the shipped built-in seed library.
 *
 * Phase 1 (this build) acts on `tools.mcp_servers` (provisioned via the harness's own CLI) and
 * `charter` (injected into AGENTS.md). `resource_scopes` are DECLARED-only (coordination, not a
 * sandbox — ADR 026 §1/§4); `tools.permissions` are parsed and forward-compatible but harness
 * permission provisioning is a fast-follow (see ADR 029 / provisioning-recipe.md "Settled vs open").
 *
 * Role is not (yet) a wire type — these types live in the CLI until the v0.3 governance gate lands.
 */

/** A concrete MCP server entry inside a role's `tools.mcp_servers`. Secrets are `${ENV}` refs. */
export const RoleMcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});
export type RoleMcpServer = z.infer<typeof RoleMcpServerSchema>;

/** Harness permission defaults. Parsed + forward-compatible; not provisioned in Phase 1. */
export const RolePermissionsSchema = z
  .object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .default({ allow: [], ask: [], deny: [] });

export const RoleToolsSchema = z
  .object({
    mcp_servers: z.array(RoleMcpServerSchema).default([]),
    resource_scopes: z.array(z.string()).default([]),
    permissions: RolePermissionsSchema,
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

export const RoleTemplateSchema = z.object({
  role: z.string().min(1),
  capacity: z.number().int().positive().optional(),
  charter: CharterSchema,
  tools: RoleToolsSchema,
});
export type RoleTemplate = z.infer<typeof RoleTemplateSchema>;

/** The no-extra-tooling default: only the musterd server + a bare charter (ADR 028). */
export const GENERALIST = 'generalist';

/** Parse + validate an unknown value as a role template (hard rule #4 — zod at the boundary). */
export function parseRole(raw: unknown): RoleTemplate {
  return RoleTemplateSchema.parse(raw);
}

/** The validated built-in seed library, keyed by role name (raw data lives in `roles/builtins.ts`). */
export const BUILTIN_ROLES: Record<string, RoleTemplate> = Object.fromEntries(
  Object.entries(BUILTIN_ROLE_TEMPLATES).map(([name, raw]) => [name, parseRole(raw)]),
);

/** Where a project's user-authored role templates live: `.musterd/roles/<name>.json`. */
export function userRolesDir(dir: string): string {
  return join(dir, BINDING_DIR, 'roles');
}

/**
 * Load a role by name for `dir`. A user file at `.musterd/roles/<name>.json` wins over a built-in
 * of the same name (customization). Throws a friendly Error if the file is missing or invalid.
 */
export function loadRole(dir: string, name: string): RoleTemplate {
  const path = join(userRolesDir(dir), `${name}.json`);
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read role ${name} (${path}): ${(err as Error).message}`);
    }
    try {
      return parseRole(raw);
    } catch (err) {
      throw new Error(`role ${name} (${path}) is invalid: ${zodMessage(err)}`);
    }
  }
  const builtin = BUILTIN_ROLES[name];
  if (builtin) return builtin;
  throw new Error(`unknown role "${name}" (no built-in and no .musterd/roles/${name}.json)`);
}

/**
 * List role names available for `dir`: built-ins ∪ user files in `.musterd/roles/*.json`.
 * `generalist` is always first (the default). De-duplicated; user files don't double-list a built-in.
 */
export function listRoleNames(dir: string): string[] {
  const names = new Set<string>(Object.keys(BUILTIN_ROLES));
  try {
    for (const f of readdirSync(userRolesDir(dir))) {
      if (f.endsWith('.json')) names.add(f.slice(0, -'.json'.length));
    }
  } catch {
    // no .musterd/roles/ — built-ins only
  }
  const rest = [...names].filter((n) => n !== GENERALIST).sort();
  return [GENERALIST, ...rest];
}

/** Is this role name a built-in (vs. a user-authored file)? Used only for UI hints. */
export function isBuiltin(name: string): boolean {
  return name in BUILTIN_ROLES;
}

function zodMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  return (err as Error).message;
}
