import type { Surface } from '@musterd/protocol';
import type { AgentBinding, McpServerEntry } from './mcpEntry.js';

export interface DetectResult {
  /** Is this harness installed on the machine? */
  installed: boolean;
  /** Is a musterd MCP server already configured for it? */
  configured: boolean;
  /** Human-readable detail (where it looked / what it found). */
  detail?: string;
  /**
   * The `MUSTERD_CLAIM` value baked into this harness's registered musterd server, if any and the
   * harness can read it back (e.g. Claude Code via `claude mcp get`). Provisioning no longer emits
   * this env (see {@link buildMcpEnv}), so a present value is a *legacy* baked claim — the doctor
   * compares it against `.musterd/binding.json` and flags a mismatch (the drift that pinned the MCP
   * tools to a stale seat after a re-claim). Undefined ⇒ not baked / not readable ⇒ nothing to check.
   */
  registeredClaim?: string;
}

export interface ConfigureResult {
  /** Where the config was written (path or CLI invoked). */
  target: string;
  /** Anything the user must do to activate it (e.g. "restart Cursor"). */
  activation: string;
  /** One line on the binding's reach — e.g. "wired into this folder only". */
  scope?: string;
  /**
   * A file written inside the working tree that now contains the member's token (plaintext).
   * Set this when the config lives in the repo (e.g. `.cursor/mcp.json`) so init can warn and
   * offer to .gitignore it. Omit when the secret lives outside the tree (e.g. Claude Code's
   * `-s local` config in `~/.claude.json`), where there is nothing to accidentally commit.
   */
  secretPath?: string;
}

/** A named MCP server entry to provision (a role's `tools.mcp_servers`); secrets stay `${ENV}`. */
export interface ProvisionServer extends McpServerEntry {
  name: string;
}

/** Harness permission entries, split by disposition (Claude Code's `allow`/`ask`/`deny`). */
export interface ProvisionPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

/** What a role asks a harness to provision: its MCP servers + permission defaults (ADR 026). */
export interface ProvisionPlan {
  servers: ProvisionServer[];
  permissions: ProvisionPermissions;
}

/** What `musterd uninstall` asks a harness to remove — by name/value, exactly what was added. */
export interface UnprovisionPlan {
  /** MCP server names to remove (role servers + the musterd server itself). */
  servers: string[];
  /** Permission entries to remove (only those musterd added — see the manifest, ADR 030). */
  permissions: ProvisionPermissions;
}

export interface ProvisionResult {
  /** Names of the MCP servers actually registered (for the uninstall manifest, ADR 030). */
  servers: string[];
  /** Permission entries *newly* added (not ones the user already had) — recorded for exact removal. */
  permissions: ProvisionPermissions;
  /** Where they were written (CLI invoked / path). */
  target: string;
  /** Anything the user must do to activate them, if different from the musterd server's. */
  activation?: string;
}

/**
 * Where a harness carries the on-demand **skill** and slash-command prompts (ADR 085). Declarative
 * *data*, not behavior — the shared `writeGuidance`/`removeGuidance` (onboard/guidance.ts) render the
 * one canonical body into these per-harness shells, so adapters stay thin. A harness with no skill
 * mechanism (Codex) simply omits this and relies on the primer's pointer to `.musterd/skill/SKILL.md`.
 */
export interface HarnessGuidance {
  /** Skill file path, relative to the binding folder (e.g. `.claude/skills/musterd/SKILL.md`). */
  skillPath: string;
  /** Frontmatter flavor for the skill file — how this harness gates the skill on a description. */
  frontmatter: 'claude-code' | 'cursor';
  /** Dir for slash-command prompt files (one `.md` per command), relative to the binding folder.
   * Omit when the harness has no project-level slash-command support. */
  commandsDir?: string;
}

/** A pluggable onboarding adapter for one agent harness. */
export interface Harness {
  id: string;
  label: string;
  /** The Presence surface a member in this harness attaches with. */
  surface: Surface;
  /** Where this harness carries the skill + slash commands (ADR 085); omitted ⇒ canonical file only. */
  guidance?: HarnessGuidance;
  detect: () => Promise<DetectResult>;
  /** Write the musterd MCP server into this harness's config. */
  configure: (entry: McpServerEntry, binding: AgentBinding) => Promise<ConfigureResult>;
  /**
   * Provision a role's Universe-2 tools (ADR 026) into this harness — additively, reversibly, and
   * per-user/local (ADR 027). MCP servers register with per-server idempotency (remove+re-add only
   * that name, never the user's others); permission defaults merge into the harness's own
   * allow/ask/deny without clamping. Optional: a harness without a renderer degrades to
   * charter-only. `scope` is `local` in Phase 1 (a `shared` opt-in is a fast-follow).
   */
  provision?: (plan: ProvisionPlan, scope?: 'local' | 'shared') => Promise<ProvisionResult>;
  /**
   * Reverse a provision (ADR 027 reversibility): remove exactly the named MCP servers and the
   * listed permission entries this harness added. Best-effort — a missing entry is a no-op.
   */
  unprovision?: (plan: UnprovisionPlan, scope?: 'local' | 'shared') => Promise<void>;
}
