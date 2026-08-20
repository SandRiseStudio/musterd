import { z } from 'zod';
import { CapabilitiesSchema } from './capabilities.js';
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
 *
 * Version 2 (ADR 281): identity no longer carries a Surface — runtime Surface comes from the
 * launcher (`MUSTERD_LAUNCH_SURFACE`, ADR 286), never from a stored file. Strict: an unknown key is
 * rejected, not stripped, so a writer can no longer derive the committed spec by parsing a Binding
 * through this schema — it must construct the exact object. A version-1 file (the pre-281 shape
 * with `surface` and no `version`) is classified `legacy` by the CLI loaders and converted only by
 * a confirmed `musterd harness configure`.
 */
export const WorkspaceSpecSchema = z
  .object({
    version: z.literal(2),
    server: z.string(),
    team: z.string(),
    /** Folder claim policy (ADR 018 ladder); absent ⇒ assign-in-chat. The claim-frame target derives from the policy (seat→{seat:name}, role→{role:role}). */
    claim: ClaimPolicySchema.optional(),
  })
  .strict();

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

/**
 * A model **observation** — what a harness was seen running this session, as opposed to `model`,
 * which is what a human or a config *declares*. Written ONLY by the SessionStart hook (`musterd
 * session start --stdin`) via the per-harness `observeModel` probe; per-machine like `session`, so
 * it is kept out of the committed `workspace.json`.
 *
 * Deliberately NOT merged into `model`. An observation that overwrote a declaration would launder
 * itself into one on the next session — the field's epistemic status becomes unknowable, which is
 * precisely the question nobody could answer about the seat that attested `grok-4.5` for weeks while
 * running `claude-opus-4-8`. Keeping the tiers apart is also what leaves the `observed ≠ declared`
 * tripwire something to compare.
 *
 * Attested, never verified (ADR 101); absent ⇒ fall through to the declared tier.
 */
export const ModelObservationSchema = z.object({
  /** The model id the harness reported. */
  model: z.string().min(1).max(120),
  /** Harness class that produced it (`claude-code`, `codex`) — matches the residency vocabulary. */
  harness: z.string().min(1).max(40),
  /** Epoch ms of the observation; newest-wins against a prior one. */
  observed_at: z.number().int(),
});

export type ModelObservation = z.infer<typeof ModelObservationSchema>;

/** The full workspace binding — the secret-free {@link WorkspaceSpecSchema} plus the two secrets.
 *  Strict like the spec (version 2, ADR 281): unknown keys are rejected, never carried along. */
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
  /** The seat's effective capabilities as of its last successful occupy (ADR 144 inc 5), cached so the
   *  NEXT session can scope its rendered MCP tool surface at connect — before it has claimed and can
   *  ask the server. Same shape as the `model` field above and written by the same path: a fact
   *  learned at claim that must survive to the next boot. A cache, never authority — the daemon
   *  enforces capabilities in-band on every send regardless (`route.ts`), and the adapter fails OPEN
   *  when this is absent (renders everything), so a stale or missing entry costs tokens, never
   *  access. One consequence, deliberately accepted: a role change reaches the tool surface on the
   *  connect AFTER the next claim, not instantly. Per-machine like `model`, so kept out of the
   *  committed `workspace.json`. */
  capabilities: CapabilitiesSchema.optional(),
  /** The captured harness session (ADR 131 §5) — see {@link SessionCaptureSchema} for the strict
   *  local-only contract. Hook-written; per-machine like `model`, so kept out of `workspace.json`. */
  session: SessionCaptureSchema.optional(),
  /** The hook-**observed** model (see {@link ModelObservationSchema}) — outranks the declared `model`
   *  above at attestation time, because a declaration is a snapshot and snapshots rot. Hook-written
   *  and per-machine like `session`, so kept out of `workspace.json`. */
  model_observed: ModelObservationSchema.optional(),
  /** Join-on-launch for THIS worktree (ADR 165 increment 2). Written by `musterd agent` (always) and
   *  `musterd wire --autojoin`; read by the adapter under the `MUSTERD_AUTOJOIN` env override. Lives
   *  here rather than the harness MCP entry because that entry is keyed by repo root and shared by
   *  every sibling worktree — a slot that may carry only what is identical across all of them.
   *  Per-workspace policy, so kept out of the committed `workspace.json` (a shared repo cloned by
   *  many must never have every clone auto-claim). Absent ⇒ dormant until an explicit join. */
  autojoin: z.boolean().optional(),
  /** The human steering this worktree's sessions (driver co-presence, ADR 021/155), written by
   *  `musterd agent --driver`. Same shared-slot argument as `autojoin`: baked into the entry it marked
   *  the WHOLE family as driven. Per-machine, kept out of `workspace.json`; `MUSTERD_DRIVER` env stays
   *  the manual override above it. */
  driver: z.string().min(1).max(80).optional(),
}).strict();

export type Binding = z.infer<typeof BindingSchema>;

/**
 * Refuse a binding the reader would not be able to parse — call this before persisting one.
 *
 * The write side and the read side of `binding.json` had drifted apart: readers run
 * `BindingSchema.parse` inside a try/catch that collapses any failure to `null`, while both
 * `saveBinding` implementations wrote whatever they were handed. A caller that satisfies the
 * TypeScript type can still violate the schema, because every Zod refinement — `.int()`, `.min()`,
 * `.regex()`, brands — is invisible to the type it validates. When that happened (a fractional
 * `started_at` from `statSync().birthtimeMs`, #508) the binding became permanently unreadable, and
 * because `null` also means "no binding here", the seat just went quiet.
 *
 * Throwing is deliberately the safer half of the trade. The alternative — completing the write — is
 * not "no worse than nothing": it destroys an identity that was working. A refused write leaves the
 * previous good binding in place, and the next capture heals it.
 *
 * Lives here, beside the schema, so the two copies of `saveBinding` (cli, mcp) cannot drift into
 * disagreeing about what is writable.
 */
export function assertWritableBinding(binding: unknown): void {
  const parsed = BindingSchema.safeParse(binding);
  if (parsed.success) return;
  const detail = parsed.error.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  throw new Error(
    `refusing to write an unreadable binding — ${detail}. This binding would fail the same schema ` +
      'every reader uses, which would make the workspace identity-less until it is repaired by hand.',
  );
}

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
