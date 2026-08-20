import type { Member } from '@musterd/protocol';
import { theme } from './theme.js';

/**
 * The v0.3 credential-display renderers (ADR 075, SPEC A.7/A.9) — the "shown ONCE, never
 * re-fetchable" output blocks for the agent key / human credential / grant mints, plus the env
 * string a harness adopts a seat with. Additive + unwired: the live `team add`/`init` token-print
 * path is untouched until the P3 atomic cutover; these land now so they track June's landed contract
 * (ADR 076: AgentKeyMint/CredentialMint/GrantMint/TOKEN_PREFIXES) and are ready for the flip to wire in.
 *
 * The env string is the spec-pinned core (SPEC A.9): `MUSTERD_TEAM` + `MUSTERD_AGENT_KEY` (mskey_)
 * + `MUSTERD_CLAIM` (seat:<name>|role:<name>|observe) + optional `MUSTERD_GRANT` (msgr_) +
 * `MUSTERD_SURFACE`. It replaces the P2 `MUSTERD_TOKEN` line. Secrets are rendered for one-time
 * display only — the caller never persists them to disk (the binding stores the claim target, not
 * the key; the key lives in the harness env / a chmod-600 vault).
 */

/** The env string a harness uses to adopt a seat via the claim handshake (SPEC A.9, ADR 075). */
export function credentialEnv(input: {
  team: string;
  agentKey: string;
  claim: string;
  grant?: string;
  surface: string;
}): string {
  const grant = input.grant !== undefined ? ` MUSTERD_GRANT=${input.grant}` : '';
  // Manual external launches declare their Surface with the ADR 286 LAUNCH marker — the retired
  // MUSTERD_SURFACE is never emitted (a registration carrying it refuses Presence attachment).
  return `MUSTERD_TEAM=${input.team} MUSTERD_AGENT_KEY=${input.agentKey} MUSTERD_CLAIM=${input.claim}${grant} MUSTERD_LAUNCH_SURFACE=${input.surface}`;
}

/** The "connect this agent via MCP with env:" block — the P3 successor to the P2 MUSTERD_TOKEN line. */
export function renderAgentEnvBlock(input: {
  team: string;
  agentKey: string;
  claim: string;
  grant?: string;
  surface: string;
}): string {
  return `${theme.meta('connect this agent via MCP with env:')}\n  ${theme.meta(credentialEnv(input))}`;
}

/** A generic "shown once, save it — it is not re-fetchable" block for a single minted secret. */
export function renderShownOnce(label: string, secret: string): string {
  return `${theme.warn(`${label}: ${secret}`)}\n${theme.meta('shown once — save it now; it cannot be fetched again')}`;
}

/** The agent-key-rotate mint block (SPEC A.7). `agentKey` is the new mskey_… shown once. */
export function renderAgentKeyMint(input: {
  team: string;
  agentKey: string;
  claim: string;
  surface: string;
}): string {
  return `${renderShownOnce('agent key', input.agentKey)}\n${renderAgentEnvBlock(input)}`;
}

/** The grant-issue mint block (SPEC A.7). The grant token (msgr_…) is the shown-once secret. */
export function renderGrantMintLabel(token: string, summary: string): string {
  return `${theme.ok('✓')} grant issued — ${summary}\n${renderShownOnce('grant token', token)}`;
}

/** The team-create composite mint (SPEC A.7): the founding human credential + agent key + the env,
 *  shown once at team creation. `seat` is the founding seat; `policy` is rendered as a one-line
 *  summary (the full Policy object is the caller's to display in --json). */
export function renderTeamCreateMint(input: {
  team: string;
  seat: Member;
  humanCredential: string;
  agentKey: string;
  claim: string;
  surface: string;
}): string {
  return [
    `${theme.ok('✓')} team "${input.team}" created — you hold the founding seat ${theme.memberName(input.seat.name, input.seat.kind)}`,
    renderShownOnce('human credential', input.humanCredential),
    renderAgentKeyMint({
      team: input.team,
      agentKey: input.agentKey,
      claim: input.claim,
      surface: input.surface,
    }),
  ].join('\n');
}
