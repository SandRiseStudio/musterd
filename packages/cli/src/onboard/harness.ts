import type { Surface } from '@musterd/protocol';
import type { AgentBinding, McpServerEntry } from './mcpEntry.js';

export interface DetectResult {
  /** Is this harness installed on the machine? */
  installed: boolean;
  /** Is a musterd MCP server already configured for it? */
  configured: boolean;
  /** Human-readable detail (where it looked / what it found). */
  detail?: string;
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

export interface ProvisionResult {
  /** Names of the MCP servers actually registered (for the uninstall manifest, ADR 030). */
  added: string[];
  /** Where they were written (CLI invoked / path). */
  target: string;
  /** Anything the user must do to activate them, if different from the musterd server's. */
  activation?: string;
}

/** A pluggable onboarding adapter for one agent harness. */
export interface Harness {
  id: string;
  label: string;
  /** The Presence surface a member in this harness attaches with. */
  surface: Surface;
  detect: () => Promise<DetectResult>;
  /** Write the musterd MCP server into this harness's config. */
  configure: (entry: McpServerEntry, binding: AgentBinding) => Promise<ConfigureResult>;
  /**
   * Provision a role's Universe-2 tools (ADR 026) into this harness — additively, reversibly, and
   * per-user/local (ADR 027). Each server is registered with per-server idempotency (remove+re-add
   * only that name, never the user's others). Optional: a harness without a renderer yet degrades
   * to charter-only. `scope` is `local` in Phase 1 (a `shared` opt-in is a fast-follow).
   */
  provision?: (servers: ProvisionServer[], scope?: 'local' | 'shared') => Promise<ProvisionResult>;
}
