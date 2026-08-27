import { z } from 'zod';
import { EnforcementPolicySchema } from './enforcement.js';
import { GuardianTiersSchema } from './guardian.js';
import { IncidentPolicySchema } from './incident.js';
import { StakesDefaultSchema } from './lanes.js';
import { LoopsPolicySchema } from './loops.js';
import { ResidencyPolicyOverrideSchema, ResidencyPolicySchema } from './residency.js';

/**
 * Credential + team-policy contracts (SPEC A.2/A.6, ADR 069 P3 / ADR 076). Secrets are minted with a
 * typed prefix + `base64url(randomBytes)` and stored **only** as sha256 hashes (SPEC A.2: "Servers MUST
 * store only hashes"); the plaintext is returned exactly once at mint and never logged or re-fetchable.
 * These types are the shared vocabulary for the daemon (mints/validates), the CLI (ADR 075), and the MCP
 * adapter (ADR 069 decision 1).
 */

/** The token-prefix registry — one namespace per secret kind, so a secret's role is legible on sight. */
export const TOKEN_PREFIXES = {
  /** Per-seat token (the v0.2 holdover; removed at the P3.3 cutover). */
  seat: 'mskd_',
  /** Per-team agent key — what an agent harness presents to claim a seat. */
  agent_key: 'mskey_',
  /** A grant token — a pre-issued or admin-approved authorization to claim. */
  grant: 'msgr_',
  /** A human credential — what a person presents to authenticate. */
  credential: 'mscr_',
  /**
   * A machine credential (ADR 328) — what an admitted daemon presents on the sync surface, and
   * nothing else. Deliberately not a seat credential: a machine being *admitted* and a seat being
   * *authorized* are independent axes, and collapsing them would make one laptop's compromise a
   * licence to mint teammates.
   */
  node: 'msnode_',
  /** A single-use, short-TTL enrollment code that mints exactly one `msnode_` (ADR 328 §2). */
  node_invite: 'msinv_',
} as const;
export type TokenKind = keyof typeof TOKEN_PREFIXES;

/** `POST /teams/:slug/agent-key/rotate` response — the new team agent key, shown **once**. */
export const AgentKeyMintSchema = z.object({ agent_key: z.string() });
export type AgentKeyMint = z.infer<typeof AgentKeyMintSchema>;

/** A minted human credential, shown **once** (issued alongside a human seat). */
export const CredentialMintSchema = z.object({ credential: z.string() });
export type CredentialMint = z.infer<typeof CredentialMintSchema>;

/**
 * Team governance policy (SPEC A.6) — daemon-side knobs an admin sets. `allow_pre_issued_grants` lets a
 * session claim with a grant token **without** a pending-request round-trip (the fast path); when false,
 * every claim without a standing grant goes through the request/approval lane.
 */
export const PolicySchema = z.object({
  allow_pre_issued_grants: z.boolean().default(false),
  /**
   * Dogfood-mode re-seat (ADR 146, on the ADR 145 §7 decision). When true, an agent harness (team
   * agent key) re-claiming an **already-bound named agent seat** occupies immediately — a notification,
   * not an admin decision — because the seat-claim wall is a gate meant for *strangers* firing on
   * *teammates*. Brand-new (never-bound) seats and role-pool claims stay gated, so member admission is
   * still a real decision. The standing authorization is **derived** from `policy + bound_at`, not a
   * stored grant row (ADR 145's "verified-ness is derived, never a second stored flag" posture). Default
   * false — an opt-in the record demands for the dogfood team, off for every team that hasn't asked.
   */
  standing_reseat_known_agents: z.boolean().default(false),
  /**
   * The to-human ask stream's one configurable behavior (ADR 147 §6, on ADR 145 §3.1). When true, an ask
   * that admins leave unanswered past its tier timeout may fall back to non-admin humans on the same
   * timeout/risk machinery — the "configurable (never automatic)" fallback the founder named. Default
   * false: admin-only routing until a team opts in. The tier→timeout spectrum itself is a shipped default
   * (protocol `ASK_TIER_DEFAULTS`), not a knob — held to a default rather than made infinitely tunable.
   */
  ask_fallback_to_nonadmin: z.boolean().default(false),
  /**
   * Slack delivery for the ask stream (ADR 149, on ADR 145 §3.2 "deliver where the human already
   * lives"). A Slack *incoming-webhook* URL; when set, the daemon fires one fire-and-forget POST per
   * `ask` raised — the loud reach beside the guaranteed reach (message row + admin push, ADR 147 §3).
   * Unset (the default) = no outbound call ever. The URL is a secret: policy reads are admin-only,
   * `team export` never serializes policy, and the CLI display masks it to its host.
   */
  ask_slack_webhook: z.string().url().optional(),
  /**
   * Seeds ingest (ADR 248) — where the daemon pulls buffered raw ideas from, and the bearer token it
   * presents. Both set = the ingest loop polls `GET <url>/seeds?after=<cursor>` and opens one lane
   * per seed (open state, unowned, stakes normal — light cleanup only, never interpretation). Either
   * unset (the default) = no outbound call ever, the same posture as `ask_slack_webhook`. The token
   * is a secret with the same handling: policy reads are admin-only, `team export` never serializes
   * policy, and the CLI masks it on display.
   */
  seeds_relay_url: z.string().url().optional(),
  seeds_relay_token: z.string().optional(),
  /** Team-wide wake-policy defaults (ADR 131 increment 5) — per-seat enrollment overrides layer on
   *  top (`ResidencyPolicyOverrideSchema` in `residency.policy`). `parse({})` yields launch defaults. */
  residency: ResidencyPolicySchema.default({}),
  /**
   * Structural enforcement (ADR 150) — the opt-in PreToolUse gate declaration. A table of *classes* the
   * team marked consequential enough to gate at the tool boundary (contended surfaces → Gate A
   * lane-ownership; costly actions → Gate B action→ask). `parse({})` yields an **empty** table: no class
   * declared means every tool call passes untouched, so the out-of-box posture stays warn-never-block
   * (ADR 083). Not a secret — but, unlike the webhook, it carries no host, so it rides `team export` and
   * the audit `detail` freely. The declaration is admin-set through `POST /policy` (audited
   * `policy.change`); the hook reads it so the gate is consistent across a team's seats.
   */
  enforcement: EnforcementPolicySchema.default({}),
  /**
   * Board-triggered loop enables (ADR 179 / ADR 191). Each switch is independently installable;
   * `parse({})` yields every loop off. A wake fires only where the matching loop is on *and* the
   * target seat's residency `flow` is `auto`.
   */
  loops: LoopsPolicySchema.default({}),
  /**
   * Admin-set default stakes by surface (ADR 244) — the configurable half of "front-end changes
   * default to low". First match wins; a lane whose declared surfaces all fall under a rule opens at
   * that rule's stakes unless the worker declared their own, and records
   * `stakes_provenance: 'defaulted'` so the ADR 234 Eval can still tell policy from judgement.
   *
   * `parse({})` yields an EMPTY list: no rule means every lane opens exactly as it did before, so
   * this is inert until a team asks for it — the same opt-in posture as `enforcement` and `loops`.
   */
  stakes_defaults: z.array(StakesDefaultSchema).default([]),
  /**
   * Guardian autonomy tiers per incident class (2026-08-13 guardian spec §4) — sparse overrides;
   * absent classes read as the guardian's shipped defaults. `parse({})` yields an empty map: inert
   * until an admin flips a class, same opt-in posture as `enforcement`/`loops`/`stakes_defaults`.
   */
  guardian_tiers: GuardianTiersSchema.default({}),
  /**
   * Shared-blocker convergence (incident spec §5, ADR 268). Unlike every block above it, this one
   * is NOT inert on `parse({})` — increment 1 shipped clustering on for every team, so the default
   * reproduces it and `enabled: false` is the opt-out. The two wake knobs inside it are opt-in, for
   * the reasons on `IncidentPolicySchema`.
   */
  incident: IncidentPolicySchema.default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

/**
 * What an admin actually chose (ADR 185) — the shape team policy is **stored** and **posted** in.
 * Partial at the top level *and* through both nested sub-objects: a top-level `.partial()` alone
 * would leave a present `residency` dense, which is precisely the bug one level down.
 *
 * Why this exists: `setPolicy` used to `PolicySchema.parse` before storing, so the first write of any
 * single knob materialized EVERY default into the row and killed the schema default for that team
 * forever. Defaults are now applied on read (`getPolicy`) and never on write. The pattern is not new
 * — `ResidencyPolicyOverrideSchema` has always been the sparse shape for per-seat overrides; team
 * policy was the odd one out.
 */
export const PolicyOverrideSchema = PolicySchema.partial().extend({
  residency: ResidencyPolicyOverrideSchema.optional(),
  enforcement: EnforcementPolicySchema.partial().optional(),
  loops: LoopsPolicySchema.partial().optional(),
  incident: IncidentPolicySchema.partial().optional(),
});
export type PolicyOverride = z.infer<typeof PolicyOverrideSchema>;

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The nested policy blocks, by key. Sparsification has to know which keys are sub-objects, and
 * naming them in a map rather than an inline ternary chain is what keeps the next block from being
 * silently omitted — an omitted key falls through to the scalar path and is kept or dropped WHOLE,
 * which is the ADR 185 bug one level down.
 */
const POLICY_SUB_SCHEMAS = {
  residency: ResidencyPolicySchema,
  enforcement: EnforcementPolicySchema,
  loops: LoopsPolicySchema,
  incident: IncidentPolicySchema,
} as const;

/** Strip the keys of one sub-object that equal their current schema default; undefined if none survive. */
function sparsifySub(
  value: unknown,
  schema: (typeof POLICY_SUB_SCHEMAS)[keyof typeof POLICY_SUB_SCHEMAS],
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const defaults = schema.parse({}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    // A key with no default (max_turns, budget_usd) can only be there because someone set it.
    if (!(key in defaults) || !sameValue(v, defaults[key])) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Recover the sparse doc from a policy blob that was stored densely (ADR 185 migration): **keep the
 * keys whose value differs from the current default, drop the ones that equal it.**
 *
 * A deliberately-chosen value that happens to equal the default is indistinguishable from one the old
 * parse baked in — the audit log recorded the post-parse result, so intent was never written down.
 * That ambiguity is unrecoverable, but bounded: stripping such a key changes nothing unless the
 * default later moves, and at that moment tracking the new default is the likelier intent for a value
 * nobody can show was chosen. A value that *differs* from the default is unambiguously deliberate and
 * is always kept.
 */
export function sparsifyPolicy(stored: unknown): PolicyOverride {
  if (typeof stored !== 'object' || stored === null) return {};
  const defaults = PolicySchema.parse({}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    const subSchema = POLICY_SUB_SCHEMAS[key as keyof typeof POLICY_SUB_SCHEMAS];
    if (subSchema) {
      const sub = sparsifySub(value, subSchema);
      if (sub) out[key] = sub;
      continue;
    }
    if (!(key in defaults) || !sameValue(value, defaults[key])) out[key] = value;
  }
  return PolicyOverrideSchema.parse(out);
}
