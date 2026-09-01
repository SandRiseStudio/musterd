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
  /**
   * The `MUSTERD_MODEL` baked into this harness's registered musterd server, if any and readable.
   * Provisioning no longer emits it, so a present value is a **legacy snapshot** sitting at the top
   * of the adapter's ladder, where no observation can correct it — the doctor flags it for removal.
   */
  registeredModel?: string;
  /**
   * The `MUSTERD_GRANT` baked into the registered server, if readable. Provisioning no longer emits it
   * (ADR 165): the entry is keyed by repo root and shared by every seat worktree, so a per-seat grant
   * in it is a credential every sibling reads. A present value is therefore drift **on presence**, not
   * on mismatch.
   */
  registeredGrant?: string;
  /**
   * The `MUSTERD_AGENT_KEY` baked into the registered server, if readable. Same story as
   * {@link registeredGrant} and strictly worse: the agent key is the *team* credential, so a stale one
   * in the shared slot means a seat may boot authenticating as a sibling rather than merely carrying
   * its grant. Provisioning no longer emits it (ADR 165).
   */
  registeredAgentKey?: string;
  /**
   * The `MUSTERD_AUTOJOIN` baked into the registered server, if readable. Provisioning no longer
   * emits it (ADR 165 inc 2): join-on-launch is per-worktree policy (`binding.autojoin`), so a baked
   * value forces the whole worktree family on (or off) at once. Drift on presence.
   */
  registeredAutojoin?: string;
  /**
   * The `MUSTERD_DRIVER` baked into the registered server, if readable. Provisioning no longer emits
   * it (ADR 165 inc 2): a driver in the shared slot marks EVERY sibling worktree as driven by that
   * human, corrupting ADR 155 driver co-presence. Drift on presence.
   */
  registeredDriver?: string;
  /**
   * The `MUSTERD_SURFACE` baked into the registered server, if readable. Same legacy-snapshot story
   * as {@link registeredModel}, and it was the one this set was missing: measured 2026-08-03, a seat
   * reported surface `cursor` while a `claude-code` hook was demonstrably the thing capturing its
   * sessions, because a pre-ADR-165 `.cursor/mcp.json` still baked `MUSTERD_SURFACE=cursor` at the
   * top of the adapter's ladder — above binding.json, where no observation can reach it (PR #607).
   */
  registeredSurface?: string;
  /** The registered launch args, so the doctor can spot an adapter inside another seat's workspace. */
  registeredArgs?: string[];
  /** Harness-local hook definitions missing or malformed; read-only doctor evidence. */
  hookDrift?: string[];
  /**
   * Where the inspected entry lives, when that file is **not** the one this harness's `configure`
   * writes for this folder — a machine-global config no repair run here can rewrite.
   *
   * Set this and every `registered*` value above becomes a report about a file the reader must edit
   * themselves. Leaving it unset asserts the opposite: that the drift sits in the file `configure`
   * owns, which is what licenses the doctor to prescribe `musterd wire`. That distinction is the
   * whole of ADR 168 — a prescription that cannot reach the drift it names is worse than none, since
   * the check then stays red through a repair that reported success.
   *
   * Measured 2026-08-05: `~/.codex/config.toml` held a musterd server with an agent key, a grant,
   * autojoin and a model baked in, while `init --check` reported "Codex: no musterd server" — the
   * global file was outside everything the detector looked at.
   */
  registeredElsewhere?: string;
}

/** The `MUSTERD_*` names provisioning no longer emits, so a baked one is legacy drift by presence. */
const REGISTERED_ENV = {
  MUSTERD_CLAIM: 'registeredClaim',
  MUSTERD_MODEL: 'registeredModel',
  MUSTERD_GRANT: 'registeredGrant',
  MUSTERD_AGENT_KEY: 'registeredAgentKey',
  MUSTERD_AUTOJOIN: 'registeredAutojoin',
  MUSTERD_DRIVER: 'registeredDriver',
  MUSTERD_SURFACE: 'registeredSurface',
} as const;

/**
 * Map a registered entry's `env` block onto the `registered*` fields the doctor inspects.
 *
 * Shared so the three harnesses cannot drift on WHICH vars count as legacy drift — which is exactly
 * what happened: the set lived only inside Claude Code's `claude mcp get` regexes, so a baked value
 * in `.cursor/mcp.json` or `.codex/config.toml` was invisible to the doctor no matter which var it
 * was. Measured 2026-08-03: one `.cursor/mcp.json` carried a per-seat AGENT KEY and GRANT plus a
 * stale surface, none of it reportable.
 *
 * Empty-string values are dropped: an env key present but blank is not a baked value, and flagging it
 * would send the reader looking for something that is not there.
 */
export function registeredFromEnv(
  env: Record<string, string | undefined> | undefined,
): Partial<DetectResult> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [name, field] of Object.entries(REGISTERED_ENV)) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') out[field] = value;
  }
  return out as Partial<DetectResult>;
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
  /**
   * Things that went deliberately un-done during configure, which the user must see (ADR 168). The
   * first case: a hook this build declined to write because a NEWER musterd wrote the installed one,
   * so installing ours would downgrade every folder on the machine. A refusal nobody is told about is
   * indistinguishable from a silent failure — which is the exact class of bug this ADR exists to end.
   */
  warnings?: string[];
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
  /** Path for the **label-sessions** skill (ADR 160 / 185 `cross_rename`) — harnesses that can list
   * peers and rename by id (Claude Code Desktop today). Omit when the harness has no peer list. */
  sessionsSkillPath?: string;
  /** Path for the **self-label** skill (ADR 186 `self_rename`) — harnesses that can rename only the
   * *current* chat (Cursor `rename_chat` today). Distinct from `sessionsSkillPath`: the apply loop
   * is inverted (label self, not peers). Omit when neither capability exists (Codex today). */
  selfLabelSkillPath?: string;
  /** Path for the **nudge-relay** skill (ADR 167) — declared only by harnesses whose sessions can
   * message each other through agent-side tools (Claude Code Desktop today, the same surface test as
   * `sessionsSkillPath`). Omit elsewhere; a `delivery_hint` an agent can't act on is simply inert. */
  nudgeSkillPath?: string;
  /** Path for the **orient** skill (session-orientation spec 2026-08-25 §B / ADR 333) — declared by
   * harnesses that catalog a native skill/rule shell (Claude Code + Cursor today). Harnesses with
   * no native catalog (Codex, OpenCode) omit this; they get the canonical `.musterd/skill/orient.md`
   * instead. Presence of this path is catalog, not a claim that the repeating nudge fires there. */
  orientSkillPath?: string;
}

/** What a harness gets to work with when observing its own session's model. */
export interface ModelObservationInput {
  /** Absolute transcript/rollout path as the harness reported it on hook stdin, if it reports one. */
  transcript_path?: string | undefined;
  /** The harness session id, for harnesses that key their own logs by it. */
  session_id?: string | undefined;
  /**
   * Structured selected-model id from a Cursor Agent hook (ADR 198). Preferred over {@link model}
   * when both are present — `model` can be a legacy/thinking slug.
   */
  model_id?: string | undefined;
  /** Legacy composer model slug from a Cursor Agent hook (ADR 198). */
  model?: string | undefined;
}

/** A pluggable onboarding adapter for one agent harness. */
export interface Harness {
  id: string;
  label: string;
  /** The Presence surface a member in this harness attaches with. */
  surface: Surface;
  /**
   * How far one registered MCP entry reaches — which decides what a baked secret in it actually
   * costs, and therefore how the doctor must explain it.
   *
   * - `repo-shared` — Claude Code: local-scope config is keyed by **repo root**, so every git
   *   worktree of one repo reads a SINGLE entry (ADR 143). A per-seat secret there is every sibling
   *   seat's credential, which is the family-bleed the ADR 165 unbake was argued from.
   * - `folder` — Cursor (`.cursor/mcp.json`) and Codex (`.codex/config.toml`): one file per folder,
   *   so there is no sibling to bleed onto. The secret is still drift, for a different and equally
   *   real reason — the file lives **inside the working tree** and can be committed (which is why
   *   {@link ConfigureResult.secretPath} exists) — and a baked snapshot still outranks binding.json.
   *
   * Recording it stops the doctor asserting Claude Code's repo-root story about a per-folder file,
   * which is what it did the moment these checks began firing for Cursor and Codex.
   */
  entryScope: 'repo-shared' | 'folder';
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
  /**
   * Rewrite **only** this harness's musterd hooks in a folder already provisioned for it — no
   * prompts, no member mint, no binding write, no MCP re-registration (ADR 168, sibling to
   * `--refresh-guidance` / ADR 161).
   *
   * This slot exists because hook *delivery* had no safe carrier. A hook's text changes whenever a
   * capability does, and a hook added later (the ADR 150 gate, the ADR 167 observer) reaches an
   * existing seat only by re-provisioning it — but full `init` is interactive, re-mints identity, and
   * re-points the worktree-family MCP entry (ADR 165). So every seat sat behind: measured 2026-07-27,
   * the ADR 167 observer was installed in 0 of 13 worktrees and the ADR 150 gate in 2 of 13, meaning
   * a declared enforcement class was silently a no-op nearly everywhere.
   *
   * `applies` reports whether the folder already carries this harness's provisioning — a refresh may
   * update what is there, never create a first install (that is `init`'s job). Returns the files it
   * wrote plus any warnings (e.g. an ADR 168 downgrade refusal).
   */
  refreshHooks?: {
    applies: (dir: string) => boolean;
    run: (dir: string) => { files: string[]; warnings: string[] };
    /**
     * The refusable surfaces (ADR 332 names) this refresh installs. The driver resurrects a
     * tombstone only when some present harness claims its surface — announcing "re-installed" for
     * a name nothing installs is a lie about the folder. Omitted means "none".
     */
    surfaces?: () => string[];
  };
  /**
   * Observe the model this harness is *actually* running for the current session. An observation
   * outranks any declaration (`resolveAttestation`), so this is the tier that stops a wire-time
   * snapshot from lying forever — the defect that had one seat attesting `grok-4.5` for weeks while
   * it ran `claude-opus-4-8`.
   *
   * **Even contract.** Every harness declares this slot with the same signature, the same
   * never-throw rule, and the same `undefined` degradation. The fidelity *behind* the slot differs
   * because harnesses differ in what they expose — that is a property of the harness, not a
   * difference in musterd's guarantees. `undefined` means "this harness cannot tell us right now",
   * which falls back to the declared tier and is reported honestly rather than guessed at.
   *
   * MUST NOT throw: this runs inside a hook, and a hook must never fail.
   */
  observeModel?: (payload: ModelObservationInput) => string | undefined;
}
