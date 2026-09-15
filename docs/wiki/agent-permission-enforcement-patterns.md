# Agent permission-enforcement patterns

A 2026-08 Reddit discussion on where agent authorization should live, distilled because its arguments map onto decisions musterd has already made (and two it has not).

## Source

["Where should an AI agent's permissions actually be enforced?"](https://www.reddit.com/r/AgentsOfAI/comments/1vvfr3o/where_should_an_ai_agents_permissions_actually_be/) — r/AgentsOfAI, posted 2026-08-22 (7 points, 5 comments at capture time). Captured to the team via Slack on 2026-08-22; lane abandoned 2026-08-25 in favor of this page. www.reddit.com blocks scripted fetches (observed 2026-08-25; falsify: any plain curl of a thread URL returning post JSON); `old.reddit.com` and the `/s/` shortlink redirect both work.

## The thread's positions

- **Runtime policy is UX, not security** (top comment, paraphrased): anything the model can reason about, it can talk itself around — a jailbreak or poisoned tool description turns in-agent policy into a suggestion. The deny decision belongs at a boundary the agent cannot rewrite: an API gateway or the credential itself.
- **Delegation must scope down, not out**: when agent A hands work to agent B, B should act under A's original authorization via a passed-down request-scoped token, not B's own defaults.
- **Audit needs one correlation id** from the human's request through every downstream call, so "who authorized this" is answerable from gateway logs without trusting anything the agent wrote about itself.
- **Idempotency keys on side-effecting calls**: without one minted at plan time, retries and self-correction loops double-fire while the audit log looks clean.
- **Sort verbs by reversibility**: reversible actions (open a PR, draft a ticket) run scoped-and-logged-after-the-fact; irreversible verbs (merge, send, refund, delete, PII) sit behind separate tools requiring human approval plus a dry-run diff of exactly what will change.

## How this maps to musterd

- The reversibility split is already our law: lanes land by auto-merge once CI passes ([ADR 192](../decisions/192-outcome-acceptance.md)), while costly or irreversible acts route to a human `ask` with hold/proceed tiers ([ADR 234](../decisions/234-tiered-acceptance.md)). The thread independently argues the same shape.
- Authorization provenance is recorded, not inferred: every lane close names `authorized_by`, and grants/keys live only as hashes server-side (hard rule 5) — the thread's "credential as boundary" position, which we reached via [ADR 127](../decisions/127-authorization-provenance-gates.md) / [ADR 129](../decisions/129-authorization-provenance-completeness.md).
- **Not yet built, worth remembering**: per-call correlation ids threaded through delegated acts (our audit ledger records acts, but delegation chains inside one outcome are not linked end-to-end), and plan-minted idempotency keys on retried side-effecting tool calls. Neither is a defect today (2026-08-25; falsify: find a wake/retry path that re-fires a non-idempotent external call — the wake ledger's deferred/failed taxonomy suggests retries are lease-bound, [ADR 241](../decisions/241-a-wake-verifies-against-its-own-lease.md)).
