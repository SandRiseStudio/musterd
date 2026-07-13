import { z } from 'zod';
import { SurfaceSchema } from './acts.js';
import { ClaimPolicySchema } from './claim.js';

/**
 * The workspace identity binding (ADR 018, P3 v0.3 per ADR 075). One file per workspace —
 * `<workspace>/.musterd/binding.json` — is the single source of truth for "who am I here", read by both
 * the CLI and the MCP adapter so they can't drift. It holds the team agent join key (a secret), so it
 * lives outside version control (init gitignores it) and is written 0600.
 *
 * P3 (ADR 075 Decision 1): the v0.2 `member` + `token` are GONE. The authenticator is the team agent
 * join key (`agent_key`, mskey_); the seat is claimed at run time via the `claim` handshake, and the
 * resolved seat (esp. a role pool's `backend-3`) is **server-side session state**, not persisted here.
 * `claim` (ClaimPolicy) is the folder's standing policy — `seat`/`role` auto-claim on launch, `chat` =
 * assign-in-chat (no auto-claim). A `chat`/human-interactive folder carries NO `agent_key` (a human
 * auths with their `mscr_` credential at claim time); `agent_key` is enforced present only for
 * seat/role auto-claim folders, at claim time. `grant` (msgr_) is an optional pre-issued grant that
 * skips the pending/admin-approval lane. Observer attaches are ad-hoc (ADR 063, no binding) — the
 * claim frame carries `observe` in ClaimTarget for that path; there is no `observe` ClaimPolicy mode.
 */
export const BINDING_DIR = '.musterd';
export const BINDING_FILE = 'binding.json';
/** The committable, secret-free launch spec (see {@link WorkspaceSpecSchema}). */
export const WORKSPACE_SPEC_FILE = 'workspace.json';

/**
 * The **secret-free** half of a workspace binding — everything the MCP launch needs *except* secrets.
 * Written to `<workspace>/.musterd/workspace.json`, which (unlike `binding.json`) is NOT gitignored, so
 * it rides the repo: a fresh clone/worktree can self-wire the musterd MCP server from it via `musterd
 * wire` without an interactive `musterd init` (the ADR-060 non-goal, unblocked by splitting the secret
 * out). The two secrets — `agent_key` (mskey_) and `grant` (msgr_) — live only in the gitignored
 * `binding.json` / env / the 0600 global config, never here. `claim` policy is the author's choice:
 * `seat:<name>` for a personal agent worktree, `role`/`chat` for a shared repo cloned by many.
 */
export const WorkspaceSpecSchema = z.object({
  server: z.string(),
  team: z.string(),
  surface: SurfaceSchema,
  /** Folder claim policy (ADR 018 ladder); absent ⇒ assign-in-chat. The claim-frame target derives from the policy (seat→{seat:name}, role→{role:role}). */
  claim: ClaimPolicySchema.optional(),
});

export type WorkspaceSpec = z.infer<typeof WorkspaceSpecSchema>;

/**
 * The captured harness session for this workspace (ADR 131 §5, increment 4) — written ONLY by the
 * SessionStart/SessionEnd hooks via `musterd session start|end --stdin`. Strictly machine-local: it
 * lives in the gitignored 0600 `binding.json` (`WorkspaceSpecSchema.parse` strips it from the
 * committed `workspace.json`), the session id and transcript path NEVER cross the wire (the daemon
 * gets a harness-class-only attestation), and the MCP adapter never reads it (no hook-vs-adapter
 * boot race). `transcript_path` powers the two local judgements: file mtime = liveness (the only
 * signal that survives a crash — SessionEnd is advisory and never fires on one), file size = the
 * context-hygiene "bloated" bound. `ended_at` set ⇒ not live, still resumable.
 */
export const SessionCaptureSchema = z.object({
  /** Harness class (`claude-code`, …) — open string, matches the residency enrollment vocabulary. */
  harness: z.string().min(1).max(40),
  /** The harness session id (`claude --resume <id>`). Local-only, never sent to the daemon. */
  id: z.string().min(1).max(120),
  /** Absolute transcript path as the harness reported it on hook stdin. Local-only. */
  transcript_path: z.string().optional(),
  started_at: z.number().int(),
  /** Set by the advisory SessionEnd hook; absent after a crash — resumability never depends on it. */
  ended_at: z.number().int().optional(),
});

export type SessionCapture = z.infer<typeof SessionCaptureSchema>;

/** The full workspace binding — the secret-free {@link WorkspaceSpecSchema} plus the two secrets. */
export const BindingSchema = WorkspaceSpecSchema.extend({
  /** Team agent join key (mskey_, ADR 075/076). Optional — absent for chat/human folders; enforced present at claim time for seat/role auto-claim. */
  agent_key: z.string().optional(),
  /** Optional pre-issued grant (msgr_) that skips the pending/admin-approval lane (ADR 075). */
  grant: z.string().optional(),
  /** Optional harness-attested model id (ADR 101) — the model this seat runs, declared at provisioning
   *  (`musterd agent --model` / `init` capturing ambient `MUSTERD_MODEL`/`ANTHROPIC_MODEL`). Read by the
   *  MCP adapter as a fallback under the env, so the seat attests by default instead of rotting to
   *  `unknown`. Kept out of the committed `workspace.json` (a model is a per-machine choice, not shared).
   *  Attested, never verified; absent ⇒ `unknown` (warn-never-block). */
  model: z.string().max(120).optional(),
  /** The captured harness session (ADR 131 §5) — see {@link SessionCaptureSchema} for the strict
   *  local-only contract. Hook-written; per-machine like `model`, so kept out of `workspace.json`. */
  session: SessionCaptureSchema.optional(),
});

export type Binding = z.infer<typeof BindingSchema>;

/**
 * Does this folder auto-claim a seat on launch (ADR 075)? Replaces the v0.2 `isClaimed` (which meant
 * "has a persisted concrete identity" — there is none in v0.3; the resolved seat is server-side
 * session state). True iff the binding carries an agent key AND a non-`chat` claim policy. A `chat`
 * folder (assign-in-chat) or a keyless human folder does not auto-claim. Call-sites that previously
 * checked `isClaimed` for "is there a live occupant" should instead ask the server (a live session is
 * server-side state, not a binding field).
 */
export function autoClaims(binding: Binding): boolean {
  return Boolean(binding.agent_key && binding.claim && binding.claim.mode !== 'chat');
}

/**
 * The fixed seat name a folder is bound to, or undefined. The v0.3 successor to reading
 * `binding.member`: only a `seat`-policy binding has a persisted seat name (`claim.name`); a `role`
 * pool resolves its seat server-side per session and `chat` has none. Use for display / the
 * cross-folder name-reuse guard, never as proof of a live occupant (ask the server for that).
 */
export function bindingSeat(binding: Binding): string | undefined {
  return binding.claim?.mode === 'seat' ? binding.claim.name : undefined;
}
