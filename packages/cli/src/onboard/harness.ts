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
}
