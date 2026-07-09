import { fileURLToPath } from 'node:url';
import { type ClaimPolicy, type Surface } from '@musterd/protocol';

/** A stdio MCP server entry: how a harness should launch the musterd adapter. */
export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentBinding {
  server: string;
  team: string;
  /** v0.3 (ADR 075): the team agent key (mskey_) the adapter claims with — replaces member+token.
   *  Optional: a keyless folder (a chat/human folder, or a `wire`d clone whose machine has no key
   *  yet) omits it — the tools are still registered; claiming then needs a key or admin approval. */
  agent_key?: string;
  surface: Surface;
  /** The seat/role this folder claims on launch. Persisted to `.musterd/binding.json` (the source of
   *  truth the adapter reads) — deliberately NOT emitted as `MUSTERD_CLAIM`; see {@link buildMcpEnv}. */
  claim: ClaimPolicy;
  /** Optional pre-issued grant (msgr_) → `MUSTERD_GRANT`, skips the approval lane. */
  grant?: string;
  /** Optional harness-attested model id (ADR 101) → `MUSTERD_MODEL`, so the seat attests by default
   *  instead of rotting to `unknown`. Only a *declared* value is baked (never a guess — a stale/wrong
   *  model is worse than none). Mirrors the `binding.json` model field the adapter also reads. */
  model?: string;
}

/** The env that binds an MCP session to its claim (05-mcp.md; v0.3 ADR 075 — agent key + claim).
 *
 * Deliberately does NOT emit `MUSTERD_CLAIM`. The seat/role a folder claims is the one field that
 * changes after provisioning (a `musterd claim <name>` re-binds the folder to a different seat and
 * rewrites `.musterd/binding.json`), and the adapter already resolves its claim from that same
 * binding (`packages/mcp/src/config.ts` — `env > binding.json > workspace.json`). Baking the claim
 * into a static `-e MUSTERD_CLAIM=` here froze a *copy* that outranks binding.json and can never be
 * updated by a re-claim: the CLI would resolve the new seat while the MCP tools stayed pinned to the
 * old one (the exact drift this omission removes). binding.json is the single source of truth; the
 * `MUSTERD_CLAIM` env stays a supported *manual* override (headless/CI with no binding.json), it
 * just isn't materialized by default provisioning. */
export function buildMcpEnv(b: AgentBinding): Record<string, string> {
  return {
    MUSTERD_SERVER: b.server,
    MUSTERD_TEAM: b.team,
    ...(b.agent_key !== undefined ? { MUSTERD_AGENT_KEY: b.agent_key } : {}),
    ...(b.grant !== undefined ? { MUSTERD_GRANT: b.grant } : {}),
    ...(b.model !== undefined ? { MUSTERD_MODEL: b.model } : {}),
    MUSTERD_SURFACE: b.surface,
  };
}

/**
 * Resolve how to launch the @musterd/mcp adapter on this machine.
 * Prefers the installed package's entry (works for both `pnpm add -g musterd`
 * and the monorepo); falls back to a sibling-package path in dev.
 */
export function resolveMcpLaunch(): { command: string; args: string[] } {
  try {
    // import.meta.resolve is sync + stable on Node 20+; returns a file:// URL.
    const url = import.meta.resolve('@musterd/mcp');
    return { command: process.execPath, args: [fileURLToPath(url)] };
  } catch {
    // Dev fallback: packages/cli/dist/onboard/ -> packages/mcp/dist/index.js
    const here = fileURLToPath(new URL('.', import.meta.url));
    const dev = new URL('../../../mcp/dist/index.js', `file://${here}`);
    return { command: process.execPath, args: [fileURLToPath(dev)] };
  }
}

export function buildEntry(b: AgentBinding): McpServerEntry {
  const launch = resolveMcpLaunch();
  return { command: launch.command, args: launch.args, env: buildMcpEnv(b) };
}
