import { z } from 'zod';
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
  /** Team-wide wake-policy defaults (ADR 131 increment 5) — per-seat enrollment overrides layer on
   *  top (`ResidencyPolicyOverrideSchema` in `residency.policy`). `parse({})` yields launch defaults. */
  residency: ResidencyPolicySchema.default({}),
});
export type Policy = z.infer<typeof PolicySchema>;
