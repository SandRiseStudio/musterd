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
 * just isn't materialized by default provisioning.
 *
 * The same reasoning retired `MUSTERD_MODEL`, and model is the *worse* field to snapshot. A claim
 * only changes when musterd acts, so a stale copy is at least explicable; a model changes when the
 * **harness** changes, with no musterd action at all, so a baked copy begins rotting the moment it is
 * written — and it sat at the TOP of that same ladder, where no later observation could correct it.
 * One seat attested `grok-4.5` for weeks while running `claude-opus-4-8`, and every repair (editing
 * binding.json, re-sending with the right value) silently lost to the baked env. The model now comes
 * from an *observation* (the SessionStart hook's `observeModel` probe) or else `binding.model`;
 * `MUSTERD_MODEL` stays a supported *manual* override, it just isn't materialized by provisioning.
 *
 * ADR 165 finished the job for the rest. The same argument applies with more force to the remaining
 * fields, because of WHERE this entry lives: Claude Code keys local-scope MCP config by **repo root**,
 * so every `agents-*` seat worktree of one repo shares a SINGLE entry. A shared slot may hold only what
 * is identical across every seat sharing it — and `MUSTERD_AGENT_KEY`/`MUSTERD_GRANT` are per-seat
 * *credentials* that the adapter ranks ABOVE binding.json (`packages/mcp/src/config.ts`), so whichever
 * seat provisioned last left every sibling presenting its secret at claim time. `MUSTERD_SERVER`,
 * `MUSTERD_TEAM` and `MUSTERD_SURFACE` are merely redundant, but they made the entry differ between
 * writers (`init`/`wire` baked them, `agent` never did), which is what turned overwriting the slot into
 * theft rather than a no-op.
 *
 * So the entry now carries NOTHING. Identity and secrets come from `.musterd/binding.json`, which the
 * adapter finds by walking up from **cwd** — a signal that is genuinely per-worktree — falling back to
 * the committed `workspace.json` for the non-secret fields. All five names remain supported *manual*
 * overrides; provisioning simply stops materializing them.
 *
 * This function is deliberately kept rather than inlined as `{}` at its call sites: it is the one place
 * the reason is written down, and the place the regression test binds. `MUSTERD_GRANT` outlived
 * `MUSTERD_CLAIM`'s removal precisely because no single place recorded the rule. */
export function buildMcpEnv(_b: AgentBinding): Record<string, string> {
  return {};
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
