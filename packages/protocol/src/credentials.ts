import { z } from 'zod';
import { EnforcementPolicySchema } from './enforcement.js';
import { ResidencyPolicySchema } from './residency.js';

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
});
export type Policy = z.infer<typeof PolicySchema>;
