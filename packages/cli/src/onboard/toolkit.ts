import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_DIR } from '@musterd/protocol';
import { z } from 'zod';
import { BUILTIN_TOOLKIT_TEMPLATES } from './toolkits/builtins.js';

/**
 * A workspace **toolkit** is a harness-agnostic *provisioning template* (ADR 026 as renamed by
 * ADR 272; docs/design/provisioning-recipe.md §1 — "role template" pre-rename). It is authored once
 * and projects into two places at use-time: the identity half (role label, capacity, charter — the
 * SERVER record, v0.3-gated and NOT built here) and the harness half (`tools` — MCP servers,
 * declared scopes, permission defaults — which the local adapter PROVISIONS, additively, into THIS
 * machine's harness). This module owns the Universe-2 half: parse + load a toolkit, and the shipped
 * built-in seed library. A toolkit carries no authority — the roster role is a team fact in a
 * different domain, the label is never derived from a toolkit, and a toolkit's `charter` field is
 * legacy-descriptive: the primer's charter comes from the team role library (ADR 272 inc 2).
 *
 * What provisioning acts on: `tools.mcp_servers` (provisioned via the harness's own CLI),
 * `tools.permissions` (compiled into the harness permission layer, ADR 261), and
 * `tools.codex_plugins` (Codex adapter writes project-local enable tables, ADR 323).
 * `resource_scopes` are DECLARED-only (coordination, not a sandbox — ADR 026 §1/§4).
 *
 * Toolkit is not (yet) a wire type — these types live in the CLI until the v0.3 governance gate
 * lands.
 *
 * History: the concept was named three times (`role` pre-ADR-272, `profile` pre-ADR-296,
 * `toolkit`). The legacy on-disk shapes were accepted on read through the transition and dropped
 * once no legacy file remained on any machine (ADR 324): only the canonical `toolkit`-keyed file
 * in `.musterd/toolkits/` loads.
 */

/** A concrete MCP server entry inside a toolkit's `tools.mcp_servers`. Secrets are `${ENV}` refs. */
export const ToolkitMcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});
export type ToolkitMcpServer = z.infer<typeof ToolkitMcpServerSchema>;

/** Harness permission defaults, compiled into the harness permission layer (ADR 261). */
export const ToolkitPermissionsSchema = z
  .object({
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .default({ allow: [], ask: [], deny: [] });

/** A Codex plugin id: `PLUGIN@MARKETPLACE` (ADR 323). Other harnesses ignore the field. */
export const CodexPluginIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/,
    'codex plugin id must be PLUGIN@MARKETPLACE',
  );

export const ToolkitToolsSchema = z
  .object({
    mcp_servers: z.array(ToolkitMcpServerSchema).default([]),
    resource_scopes: z.array(z.string()).default([]),
    permissions: ToolkitPermissionsSchema,
    /** Declared Codex plugins; the Codex adapter writes project-local enable tables (ADR 323). */
    codex_plugins: z.array(CodexPluginIdSchema).default([]),
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

export const ToolkitSchema = z.object({
  toolkit: z.string().min(1),
  capacity: z.number().int().positive().optional(),
  charter: CharterSchema,
  tools: ToolkitToolsSchema,
});
export type Toolkit = z.infer<typeof ToolkitSchema>;

/** The no-extra-tooling default: only the musterd server + a bare charter (ADR 028). */
export const GENERALIST = 'generalist';

/** Parse + validate an unknown value as a toolkit (hard rule #4 — zod at the boundary). */
export function parseToolkit(raw: unknown): Toolkit {
  return ToolkitSchema.parse(raw);
}

/** The validated built-in seed library, keyed by toolkit name (raw data: `toolkits/builtins.ts`). */
export const BUILTIN_TOOLKITS: Record<string, Toolkit> = Object.fromEntries(
  Object.entries(BUILTIN_TOOLKIT_TEMPLATES).map(([name, raw]) => [name, parseToolkit(raw)]),
);

/** Where a project's user-authored toolkits live: `.musterd/toolkits/<name>.json`. */
export function userToolkitsDir(dir: string): string {
  return join(dir, BINDING_DIR, 'toolkits');
}

/**
 * Where a toolkit may live: the canonical `.musterd/toolkits/` only. The two legacy homes
 * (`.musterd/profiles/` pre-ADR-296, `.musterd/roles/*.json` pre-ADR-272) stopped being read in
 * ADR 324 — `.musterd/roles/` now belongs solely to the roster-role TOML library. One list, so
 * the loader and the lister can never disagree about which files exist.
 */
const TOOLKIT_HOMES = [userToolkitsDir] as const;

/**
 * The toolkit search path for `dir` — the one list every reader walks. Callers outside this
 * module use it instead of naming the homes themselves, so adding or retiring a home is one edit
 * and no caller silently keeps the old set.
 */
export function toolkitHomes(dir: string): string[] {
  return TOOLKIT_HOMES.map((home) => home(dir));
}

/**
 * Load a toolkit by name for `dir`. A user file wins over a built-in of the same name
 * (customization). Throws a friendly Error if the file is missing or invalid.
 */
export function loadToolkit(dir: string, name: string): Toolkit {
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
      return parseToolkit(raw);
    } catch (err) {
      throw new Error(`toolkit ${name} (${path}) is invalid: ${zodMessage(err)}`);
    }
  }
  const builtin = BUILTIN_TOOLKITS[name];
  if (builtin) return builtin;
  throw new Error(
    `unknown toolkit "${name}" (no built-in and no .musterd/toolkits/${name}.json)`,
  );
}

/**
 * List toolkit names available for `dir`: built-ins ∪ user files in every home in
 * {@link TOOLKIT_HOMES}. `generalist` is always first (the default). De-duplicated; user files
 * don't double-list a built-in.
 */
export function listToolkitNames(dir: string): string[] {
  const names = new Set<string>(Object.keys(BUILTIN_TOOLKITS));
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
  return name in BUILTIN_TOOLKITS;
}

function zodMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  return (err as Error).message;
}
