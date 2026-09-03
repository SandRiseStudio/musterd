# 364 — Tokens are the attested unit when the harness prints no price

- Status: accepted
- Date: 2026-09-02
- Relates to: ADR 252 (a wake's spend is attributed by identity or not at all — `cost_usd` absent,
  never fabricated), ADR 236 / ADR 173 (absence is not zero), ADR 251 §6 (the native backend prices
  engine usage from a list table it holds), ADR 128 (what never leaves the daemon)
- Lane: `01M1HJY3JFSTJ4JAX7PXC4YFZ7`

## Context

Lane `01M1G310Y7` (#1184) put every codex and opencode wake on the `residency.wake_cost` rail with a
host-measured `duration_ms` and left `cost_usd` absent, per ADR 252: no cost source existed on that
path and a plausible number would have been fabricated. This lane asked what the harnesses actually
print at turn end, from one real run each rather than from memory (2026-09-02, this machine;
captured stdout is quoted verbatim in the adapter tests):

- **`codex exec --json` (codex-cli 0.152.1):** one `turn.completed` line —
  `usage: {input_tokens: 19818, cached_input_tokens: 11136, cache_write_input_tokens: 0,
  output_tokens: 5, reasoning_output_tokens: 0}`. No model name, no price. The seat is signed in
  with ChatGPT tokens (`auth_mode` in `~/.codex/auth.json`), so there is no marginal dollar price
  for the host to look up even if it held a table: a subscription turn costs tokens against a quota,
  not cents.
- **`opencode run --format json` (1.18.27):** one `step_finish` per step —
  `part.tokens: {total: 10769, input: 10453, output: 11, reasoning: 64, cache: {write: 0, read: 241}}`
  and `part.cost: 0`. The `cost` is opencode's own computation from its bundled model table; the
  host holds no copy of that table, does not know which provider or model answered, and cannot tell
  a free model from an unlisted one. A literal `0` here is exactly the "plausible number" ADR 252
  refuses.

Both harnesses therefore give the host a **fact it can copy** — token counts from a typed event —
and neither gives it a **price it can attest**. The native backend is the contrast: ADR 251 §6
prices from a table the host owns, keyed by a model it chose, and an unlisted model prices to
`undefined`, not `0`.

## Decision

**A settled wake records the tokens the harness printed, the reason no price is attested, and —
where the harness printed one — the harness's own price as its claim. `cost_usd` stays absent.**

1. **`WakeReportBody` gains three optional fields**, riding the same supplementary report ADR 252
   introduced: `usage` (`input_tokens`, `output_tokens`, optional `cached_input_tokens`,
   `cache_write_input_tokens`, `reasoning_output_tokens`), `unpriced_reason`, and
   `harness_cost_usd`. The daemon writes all three onto the `residency.wake_cost` audit row as sent.
2. **`unpriced_reason` is a fact about the harness's output, never a guess about billing.** Two
   values, each decidable from the event shape alone:
   - `harness_prints_no_price` — token counts and nothing else (codex). Set on every codex run,
     including one killed before turn end: the reason is a property of the harness, not of the
     run.
   - `harness_price_unverified` — a price was printed that the host cannot check (opencode). The
     figure rides as `harness_cost_usd`, summed across steps.
   The host does not read `auth.json` to classify a seat as "subscription": that would be a
   credential file opened for a field the event shape already answers.
3. **`harness_cost_usd` never enters a total.** `cost_usd_total`, `cost_usd_per_wake` and
   `cost_reported` read `cost_usd` only, so a wake carrying `harness_cost_usd: 0` still counts as
   unpriced and still reads as "at least this much". ADR 236 holds: a printed zero is not an
   attested zero.
4. **No price table for third-party harnesses.** Pricing codex or opencode tokens in dollars would
   need a table the team maintains per provider and model, plus a rule for unlisted models and for
   subscription seats. That is a policy the team has not needed: what the ledger exists to catch —
   a wake loop, a seat that pays for every act twice — is visible in tokens. If a dollar figure is
   ever needed for these harnesses it is its own ADR, and it prices from a table the host owns, as
   ADR 251 §6 does.

### Rejected

- **Trusting opencode's `cost`.** It printed `0` for a paid provider on this machine. Storing that
  as `cost_usd` would make the seat read free.
- **Deriving cost from tokens with Anthropic's table.** Wrong provider, wrong model, and the exact
  fabrication ADR 252 named.
- **A `subscription` reason.** True for this codex seat, but the host would learn it by reading a
  credential file; the event shape already says everything the ledger needs.

## Consequences

- Every codex and opencode wake that reaches turn end now leaves a token count on the ledger; every
  one that settles leaves a reason. A wake loop on a codex seat is countable in tokens the same
  session it happens, which is the visibility lane `01M1G310Y7` was opened for.
- `unpriced_sessions` (ADR 252) is unchanged in meaning and will not shrink from this change: these
  wakes are still unpriced. It now has a reason column beside it.
- Consumers of `residency.wake_cost` that assumed `cost_usd` or nothing must tolerate a row with
  `usage` and no `cost_usd`. `musterd report` already does (it reads `cost_usd` only).

## Observability & Evaluation

**Traces** — `residency.wake_cost` rows carry `usage`, `unpriced_reason`, `harness_cost_usd`.
Falsify on a live wake:
`sqlite3 ~/.musterd/musterd.db "select target, json_extract(detail,'$.usage.input_tokens'), json_extract(detail,'$.unpriced_reason') from audit where action='residency.wake_cost' and ts > (strftime('%s','now')-86400)*1000"`
— a codex or opencode row after this lands with a null reason falsifies the adapter; a row with
`cost_usd` set on either harness falsifies decision 4.

**Eval** — share of settled codex/opencode wakes whose row carries `usage`, over the next 30 such
wakes. Below ~80% means the harness's turn-end line is not reaching the adapter (a killed run,
a shape change upstream) and the parser needs re-capturing from a real run, the way this ADR was
written. Owner: whoever next reads the wake ledger; the lane that opened this ADR is the precedent.

**Experiment** — none planned. The one worth running if a dollar figure is ever wanted for these
harnesses: price the same 30 wakes' `usage` against the provider's published list and against
opencode's printed `harness_cost_usd`, and read how often the two agree — that is the evidence a
price-table ADR would need, and it costs nothing until then.
