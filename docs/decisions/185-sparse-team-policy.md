# 185 — Team policy is stored sparsely: a default stays a default

- Status: proposed — 2026-07-30. Authored by ryder from a brainstorm with nick the same day, on a
  lane opened by stanley (`01KYRM2ZCC`) while he recalibrated the resume-hygiene bound in #530.
  Number **185** — verified free against `origin/main` at branch time (highest there: 184).
- Date: 2026-07-30
- Builds on: [ADR 076](076-v0.3-p3-1-credential-grant-substrate.md) (the team policy blob this ADR
  changes the storage shape of), [ADR 131](131-harness-residency-wake-ledger-host.md) (the residency
  sub-object whose defaults were the first casualty, and whose seat-level override is the shape this
  ADR copies), [ADR 127](127-authorization-provenance-gates.md) (the `policy.change` audit row this
  ADR makes intent-recoverable), [ADR 150](150-structural-inducement-pretooluse-gates.md) (the
  `enforcement` class table, the other nested sub-object), [ADR 146](146-dogfood-reseat-grant.md) /
  [ADR 147](147-human-ask-stream.md) / [ADR 149](149-ask-surfaces.md) (the flat knobs that share the
  blob).

## Context

`setPolicy` ([`packages/server/src/store/teams.ts`](../../packages/server/src/store/teams.ts))
parses before it stores:

```ts
const parsed = PolicySchema.parse(policy);
db.prepare('UPDATE teams SET policy = ? ...').run(JSON.stringify(parsed), ...);
```

`parse` fills defaults. So the **first write of any single knob materializes every default into the
row**, and from that moment the schema default is dead for that team: `getPolicy` parses a row that
already carries an explicit value for everything, and the constant in the source can never reach it
again.

This is not a tidiness complaint. A default is the main lever for tuning a fleet you cannot
configure team-by-team, and this inverts it: changing a default is a no-op on exactly the teams that
have been used enough to have policy, and a live change on the ones that have not.

### It already cost an afternoon

On 2026-07-29 the resume-hygiene bound was recalibrated against the wake ledger: `transcript_max_bytes`
went from 10 MiB to 256 KiB in `ResidencyPolicySchema`, because 10 MiB counted lives rather than
dollars and sat ~23× past the point where resume stops being the cheap option. That code change did
nothing for `revive`, whose row still read `10485760`. It took a hand-edit of stored data on top of
the code change to actually take effect. Nobody had ever chosen 10 MiB for `revive` — somebody set
`standing_reseat_known_agents`, and the parse baked in the rest.

The fleet is split by this. Live at authoring time:

| team                                         | `teams.policy`     | tracks schema defaults? |
| -------------------------------------------- | ------------------ | ----------------------- |
| `revive`                                     | fully materialized | no — every knob frozen  |
| `dawn`, `lab`, `difftest`, `bench`, `bench2` | `NULL`             | yes                     |

Two populations that respond differently to the same code change, with nothing on any surface saying
which is which.

### The audit log cannot disambiguate either

The obvious question for a migration is: which stored values did a human actually choose? The lane
noted the audit log as the place to look. It was checked, and the answer is no. The `policy.change`
row writes `detail: policy` — the **post-parse** result, not the request body
([`http.ts`](../../packages/server/src/transport/http.ts)). Both live rows are fully dense. Intent
was never recorded anywhere.

### The failure survives a server-side fix alone

Both CLI write paths are dense by construction. `musterd team policy` merges its flags into a
`getPolicy` result; `musterd residency policy` posts `{ ...current, residency }`. `current` is
defaults-applied. Storing sparsely in `setPolicy` without changing the round-trip would be undone by
the very next CLI write. This is a wire-shape change, not a one-function change — which is the main
reason it earns an ADR.

### The correct shape is already in the codebase

`ResidencyPolicyOverrideSchema` is `ResidencyPolicySchema.partial()`, and `effectiveWakePolicy`
layers a sparse override over dense team defaults, keeping only explicitly-set keys. Per-seat
overrides are sparse and stay sparse. **Team policy is the odd one out.** This ADR does not invent a
pattern; it extends the one already proven a layer down.

## Decision

**Store what was chosen. Apply defaults on read, never on write.**

### `PolicyOverrideSchema` — sparse through the nesting

A sibling of `PolicySchema` in `@musterd/protocol`: `.partial()` at the top level, with
`residency: ResidencyPolicyOverrideSchema.optional()` and
`enforcement: EnforcementPolicySchema.partial().optional()` so sparseness reaches _through_ the two
nested sub-objects rather than stopping at the top. A top-level `.partial()` alone would leave a
present `residency` dense, which is the whole bug one level down.

### `getPolicy` does not change

It stays dense, defaults applied, same signature. Every read consumer — `effectiveWakePolicy`, the
ADR 150 gate, ask reachability — is untouched. `getStoredPolicy` is added beside it for the sparse
doc, and only the write path and the display read it. This keeps the blast radius at the write
round-trip, where the bug is.

### The wire carries the sparse doc; `POST` keeps replace semantics

- `GET /teams/:slug/policy` returns `{ policy, stored }` — effective and sparse.
- `POST /teams/:slug/policy` accepts `PolicyOverrideSchema` and stores it verbatim. It still
  **replaces** rather than patches.
- The CLI merges its flags into `stored` instead of `policy`, at both write sites.

Replace-not-patch is deliberate. It preserves the existing CLI idioms exactly, and gives them back
their intended meaning: `delete merged.ask_slack_webhook` (the `--ask-slack-webhook off` path) now
genuinely restores "unset = no outbound call ever" instead of storing the default, and
`--reset-policy` becomes `delete residency`, which now truly means launch defaults. PATCH semantics
would require inventing a null-means-unset convention for a blob that has an `.optional()` secret in
it — a new ambiguity in exchange for saving one round-trip.

### The audit records the request

`policy.change` writes the sparse request rather than the parsed result. This does not recover the
intent already lost, but it means the next person asking "was this chosen, or baked in?" gets an
answer from the record instead of a design pass.

### Chosen vs inherited is rendered

`musterd residency policy` and `musterd team policy` mark each value as stored-explicit or inherited
from the schema default. Once storage is sparse this is a key check, not a feature — and it is the
part that addresses the actual trap. The mechanism failed silently: gates passed, tests passed, the
constant read correctly in the source, and nothing changed at runtime.

### Migration: keep-if-differs, strip-if-equal

One migration pass over `teams.policy`, for every non-NULL row: drop each stored key whose value
equals the **current** schema default; keep the rest.

The lane flagged the ambiguity here as the hard part — a team that deliberately set cooldown to 30m
is indistinguishable from one that had 30m baked in, and the audit log cannot break the tie. It is
genuinely unrecoverable. But its consequence is bounded, which makes the rule decidable without
testimony:

- **Value differs from the current default** → unambiguously deliberate. Kept.
- **Value equals the current default** → ambiguous, but stripping it changes nothing _unless the
  default later moves_ — and at that moment, tracking the new default is the likelier intent for a
  value nobody can show was chosen.

On `revive` this lands right with no human input: `standing_reseat_known_agents: true` differs from
`false` and is kept; `transcript_max_bytes: 262144` equals the new default and is stripped, so it
keeps tracking it; every baked residency knob is stripped. The residual risk — a deliberately
default-valued knob silently starting to track a future default change — is real, and the
explicit/inherited display is what makes it discoverable and re-pinnable rather than silent.

## What deliberately does not change

- **`getPolicy`'s signature and semantics.** Read consumers keep receiving a fully-populated policy.
  Sparseness is a storage and wire concern, not a consumer concern.
- **Per-seat residency overrides.** Already sparse, already correct. Untouched.
- **The wake order's unconditional `transcript_max_bytes`**
  ([`residency.ts`](../../packages/server/src/store/residency.ts)), which makes the CLI's own
  `RESUME_TRANSCRIPT_MAX_BYTES` fallback unreachable in production. The lane flagged it as
  compounding. It is recorded here as **by design**: server-default-beats-client-fallback is the
  correct precedence, and "fixing" it would install a third competing default rather than remove
  one. The three-defaults-stacked observation is right; the resolution is that only one of them
  should ever bind, and it does.
- **`POST /policy` staying admin-only, and `GET /enforcement` staying member-readable.** The
  read/write authorization split is unchanged.

## Observability & Evaluation

The mechanism's defining property is silence, so the check is that silence is gone:

- **Traces.** The `policy.change` audit row now carries the sparse **request** rather than the
  post-parse result, so the trace answers "which knob did a human choose, and when" — the question
  the old dense detail made permanently unanswerable. `musterd residency policy` renders
  explicit-vs-inherited, so a team's real posture is one command away rather than a database read.
- **Eval.** No dataset, no baseline — deliberately. This is a mechanical storage-shape change with
  no agent-facing behavior to score: nothing here changes what a model does or how well it does it.
  What replaces an eval is direct assertion. A test writes one knob to a fresh team and asserts the
  stored row contains **only** that knob (the exact assertion whose absence let this ship); a second
  moves a schema default after a write and asserts `getPolicy` returns the new value for the
  untouched knobs — the regression that actually cost the afternoon; a third runs the migration on
  the real `revive` blob and pins seven stored keys in, one out.
- **Experiment.** None, and none is warranted: the claim ("a default change reaches a configured
  team") is a deterministic property of the code, not a hypothesis about behavior under uncertainty.
  The success criterion for the next default retune is that it needs **no** accompanying data
  change — that is the measurement, and it is a single observation on the next occurrence rather
  than a metric to watch.
- **Not instrumented.** No counter, no dashboard. One team on one machine has a non-NULL policy;
  an aggregate here would be measuring a fleet of one.

## Consequences

- A default change reaches every team again, which is what a default is for.
- The storage shape now says something true: a stored key means somebody chose it.
- Three write surfaces move together (store, HTTP, CLI). A future caller that posts a dense policy
  still works — it just stores dense, and that team goes back to being frozen. The schema cannot
  prevent this; the display makes it visible.
- Ambiguity is not resolved retroactively for values equal to their default. It is bounded,
  recorded, and discoverable, and it is recorded going forward by the audit change.

## Related

- Lane `01KYRM2ZCC`, opened by stanley 2026-07-29.
- [#530](https://github.com/SandRiseStudio/musterd/pull/530) — the recalibration that needed a data
  change on top of a code change, which is how this was found.
