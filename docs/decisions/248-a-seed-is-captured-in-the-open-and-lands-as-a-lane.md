# 248 — A seed is captured in the open and lands as a lane

- Status: proposed
- Date: 2026-08-06
- Deciders: nick (the design, brainstormed with dolly), dolly (the spec, the three defended
  constraints, and the handoff), stanley (implementation)
- Note: this replaces a draft that briefly existed as "ADR 244" — that number landed as
  admin-default stakes (#707) while the draft sat uncommitted, and the draft itself was lost (see
  ADR 223; the parked-outside-any-PR variant is a detector gap the stub ritual does not cover).

## Context

Ideas arrive when the laptop is shut. nick's raw ideas — a sentence from a phone, a line in Slack —
had no path into musterd; by the time a seat was open, the idea was gone or reconstructed from
memory. The board is where work lives, so an idea that wants to become work should land there, in
the open, as the thing every other unit of work already is: a lane.

The design was brainstormed by nick and dolly and settled before implementation. What follows
records it and its reasons.

## Decision

**1. Two always-on capture channels, independent of the laptop.** Inbound Twilio SMS to a dedicated
number, and a dedicated Slack channel (Events API). Both terminate at an always-on public Cloudflare
Worker (`workers/seeds-relay/`) cloned from the sandrise podcast-ingest worker — signature
verification (Twilio HMAC-SHA1, Slack v0 signing with the 5-minute staleness window), the TwiML
responder, and the route guard kept; every trace of podcast enrichment dropped.

**2. The relay buffers the RAW seed untouched, and the buffer is the source of record.** Each
verified event stores `{ id, body, ts, source: 'sms'|'slack', meta }` in KV, verbatim. This is what
lets an idea survive a shut laptop — so the Worker must never be the thing that interprets. It
captures and acknowledges; nothing else. Confirmations differ by channel on purpose: SMS gets an
empty TwiML ack (no outbound SMS, no Twilio spend), Slack gets "🌱 saved" in-channel via the
incoming webhook, fire-and-forget and detached so a dead webhook can neither slow nor fail capture.
The Slack handler accepts only fresh, human, top-level channel messages — skipping bot messages is
what keeps the confirmation from re-entering as a new seed.

**3. Ingest is a pull that creates the lane immediately — a seed IS a lane the moment it is
ingested.** The daemon polls `GET /seeds?after=<cursor>` (bearer token) once a minute where team
policy sets `seeds_relay_url` + `seeds_relay_token` (both new, optional, secret-handled like
`ask_slack_webhook`: unset = no outbound call ever). Each new seed becomes one lane via the same
`openLane` every other lane uses: **open state, unowned, stakes normal**, editable afterwards. There
is no draft state, no review step, no pre-lane inbox item — a rough title is fixed on the lane
itself, where fixing it is one `lane_update` instead of a workflow.

**4. Light cleanup ONLY, and it is deterministic.** Title = first non-empty line, whitespace
collapsed, cut at a word boundary at 80. Detail = the raw body verbatim plus a provenance trailer
(channel, capture time, relay id). Explicitly not at ingest, each considered and cut in the design:
no reasoning, no auto-tagging, no stakes or goal suggestion, no duplicate detection. **A seed that
arrives pre-judged is a lane someone has to argue with instead of edit.** Deterministic also means
no model call on the ingest path — nothing to attest, nothing to bill, nothing to be wrong.

**5. One-way flow, two artifacts, neither written back.** The raw seed stays in the relay buffer
(the record); the lane is the working artifact. Ingest never deletes or marks the buffer, and
nothing ever edits a lane back into the buffer. The daemon's only durable state is a per-team
cursor (`seeds_ingest_cursor`, migration v37), advanced in the same transaction as each lane insert
so a crash mid-batch resumes without duplicating lanes. A dedicated table, deliberately: the
`seed.ingested` audit row exists for observability, and reading it back as ingest state would put
one row under two consumers with different needs — the defect class
[ADR 247](247-documented-discard-is-a-precondition.md) names, on the day it was named.

**6. A seed's lane is attributed to the human it came from.** `created_by` = the team's human admin
(else its first human member). The seed originated on a human's phone or Slack; attributing it to an
agent seat would be false provenance (ADR 109 posture). A team with no human member gets no seeds,
logged. The board message any `lane_open` produces is emitted for seeds too, marked
`(seed via sms|slack)`.

**7. The relay lives outside the pnpm workspace** (`workers/seeds-relay/`, own package.json,
deployed with wrangler). It shares no code with the daemon and must not add monorepo dependencies:
autorefresh does not `pnpm install`, so a dep-adding merge pins the shared daemon — measured at an
hour of fleet-wide inertness the night this was written. The cost is that the workspace gates do not
typecheck it; it carries its own `npm run typecheck`, and the ADR records the trade.

## Consequences

- An idea texted at midnight is on the board by the daemon's next poll after the machine wakes —
  titled, attributed, and editable, with the verbatim original one hop away.
- The board gains lanes nobody asked for in-session. That is the point, but it means seed lanes are
  subject to the same sweep/staleness machinery as every other open lane; a seed nobody claims will
  age like any unclaimed lane. No special casing.
- Deployment has manual steps (KV namespace, four secrets, Twilio webhook, Slack app) — runbook in
  `workers/seeds-relay/README.md`. The feature is inert for every team until policy names a relay.
- The pull endpoint returns at most 100 seeds per call; the backlog drains across polls. If a
  thousand-seed backlog ever becomes normal, the buffer has outgrown KV and this ADR should be
  revisited rather than the page size raised.

## Observability & Evaluation

**Traces.** One `seed.ingested` audit row per lane opened (actor = the attributed human, target =
the lane, detail `{ seed_id, source, lane, captured_at }`), plus the ordinary `lane_open` board
message. Daemon logs: `seeds_ingested` (count per pass), `seeds_pull_failed` (relay unreachable —
expected while offline, it is why the buffer exists), `seeds_no_human_author`. The relay side keeps
the KV buffer itself as the capture record; `captured_at` vs the audit row's `ts` measures
capture-to-board latency without any added instrumentation.

**Eval.** The claim under test: capture-to-board works end to end and loses nothing. Metric:
every seed in the relay buffer with id ≤ the team's cursor has exactly one lane whose detail cites
its relay id — checkable by joining the buffer against `seed.ingested` rows. Baseline: zero
(the channel did not exist; ideas outside a session had no recorded path in). The through-DB tests
assert the parts a join cannot: cursor advance is transactional with the lane insert, a re-pull
after restart opens nothing twice, a relay failure moves nothing, and unset policy makes no
outbound call.

**Experiment.** None yet, and the falsifier is usage-shaped: if after a month of live use the seed
lanes on the board are predominantly unclaimed and unedited — captured but never worked — then
capture was not the bottleneck in the idea pipeline and the always-on infrastructure should be
retired to a note rather than maintained. The counter-outcome worth recording is a seed lane that
ships: the first `seed.ingested` row whose lane reaches `done` closes the loop the feature was
built for.
