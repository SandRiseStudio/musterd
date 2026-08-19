# Shared Seeds before Lanes

- Date: 2026-08-19
- Status: design approved in conversation (nick + gptbot); implementation plan to follow
- Decision: ADR 291; supersedes ADR 248's immediate Seed-to-Lane ingest rule

## Goal

Preserve a human's away-from-keyboard idea as an immutable, shared Team Seed. Let one agent at a
time perform exhaustive exploration, ask the submitting Member only the minimum clarification
needed, and create a Lane only when the resulting brief makes work decision-ready.

## Non-goals

- Editing or enriching the raw Worker/KV capture.
- Automatic background assignment of Seeds to agents.
- A required human brainstorm, meeting, or approval gate for promoted Lanes.
- OAuth or a general Slack account-linking product.
- Backfilling historical seed-created Lanes.

## Seed model

A Seed belongs to one Team and carries immutable source fields: relay id, original body, capture
time, `slack` source, Slack user id, and resolved submitting Member. Mutable fields are lifecycle
state, active explorer, final brief or conclusion, promotion metadata, and visibility timing.

States and transitions:

| State | Meaning | Allowed transition |
| --- | --- | --- |
| `open` | researchable and unclaimed | agent claim → `exploring`; manual promotion → `promoted` |
| `exploring` | exactly one agent owns research | ask clarification → `needs_clarification`; final brief → `completed` or `promoted` |
| `needs_clarification` | one precise explorer question waits for the submitter | submitter answer → `clarified`; manual promotion → `promoted` |
| `clarified` | answer is recorded and ready for a fresh claim | agent claim → `exploring`; manual promotion → `promoted` |
| `completed` | research concludes no Lane is warranted | manual promotion → `promoted` |
| `promoted` | an ordinary Lane was created and linked | terminal |

Clearly underspecified captures begin at `needs_clarification`; no agent spends research capacity
on them. The source body is immutable in every state.

## Public thread and permissions

Every Member can read a Seed and its thread. The thread is deliberately narrow:

- The active explorer asks one minimal, decision-blocking clarification at a time.
- Only the submitting Member answers it; the server rejects an answer from any other Member.
- The explorer posts exactly one final brief, rather than incremental progress reports.
- All Members may see the question, answer, final brief, and terminal conclusion.

The system resolves the submitting Member from an optional `slack_user_id` on a human Member. A
signed Slack delivery whose user id is unmatched is acknowledged `200 OK` so Slack does not retry,
but no Seed is stored. Its diagnostic reason is non-content `unknown_submitter`.

## Exploration brief and results

The explorer's final brief must include:

1. Sharpened problem framing.
2. Relevant Team and code context, plus external evidence where relevant.
3. Viable approaches, trade-offs, constraints, risks, and unknowns.
4. A recommendation.
5. A proposed Lane title and framing.

For a viable result, the daemon atomically creates an ordinary unowned Lane from the proposed title
and framing, marks the Seed `promoted`, and emits the normal Team Lane-open activity with Seed
provenance and the note that a human brainstorm is recommended. The Lane has no special gate.

For a non-actionable result, the daemon marks the Seed `completed` with the conclusion attached.
Any Member may manually promote any Seed. Manual promotion of an unexplored Seed uses the raw text
and records `research_skipped`.

## Tray and history

The shared Seed tray shows `open`, `exploring`, `needs_clarification`, and `clarified` Seeds. A
promoted Seed leaves the default tray immediately. A completed Seed leaves after three days. Both
remain searchable in history with their source, thread, result, and linked Lane.

## Architecture and integrity

The Worker continues to authenticate Slack and write raw captures to KV. The daemon ingest loop
projects each accepted relay id into a Seed rather than calling `openLane`. A durable Seed table,
Seed-thread records, and typed Seed API/protocol shapes own the Team-visible state. Existing Lane
records do not become Seeds.

Ingest deduplicates by relay id. Promotion writes the Lane linkage and Seed state in one transaction.
Failed pulls, rejected captures, and invalid transitions leave the cursor and durable state
unchanged. The server, not a client, enforces explorer ownership and submitter-only clarification.

## Verification

- A valid mapped Slack capture creates one immutable Seed; retrying the relay id creates none.
- An unmapped signed Slack sender is acknowledged but creates no Seed.
- All Members can list/read Seeds and their threads; only the active explorer asks, and only the
  submitter answers.
- A vague Seed enters `needs_clarification` without an exploration claim; an answer makes it
  claimable again.
- A second agent cannot claim an exploring Seed.
- A final viable brief creates exactly one linked Lane across retries; a conclusion creates none.
- Manual promotion works from each non-promoted state and records skipped research when applicable.
- Promoted and completed Seeds leave the tray at the specified times but remain in history.
- Audit and telemetry assertions prove that body text never appears in diagnostic fields.

## Sequencing

1. Specify the Seed domain, transitions, permissions, and Slack user-id mapping in
   `@musterd/protocol`; update the normative specification through ADR 291.
2. Replace immediate-Lane ingestion with the durable Seed store, endpoints, authorization, and
   transactional promotion in `@musterd/server`.
3. Add Seed tray, history, claim, clarification, brief, conclusion, and manual-promotion commands
   to the CLI, then expose equivalent MCP tools.
4. Add the shared Seed tray and linked-Lane provenance to the web surface.
5. Dogfood the initial vague-seed rule and three-day completed visibility window; revise only from
   recorded outcomes.
