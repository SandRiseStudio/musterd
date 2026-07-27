# 165 — Worktree-family MCP entry: a shared slot carries no per-seat state

- Status: accepted — 2026-07-27. Authored by izzo (lane `01KYAWFCGG7YZ80H1RWEF4CXQ1`, opened by
  ryder 2026-07-24). Spec + plan merged ahead of this file (PR #400). Number **165 pinned** — it
  collided three times while unpublished (159 → miley #380, 164 → stanley #395, then 166 → stanley
  #401, who took 166 specifically to keep 165 free for this ADR).
- Date: 2026-07-27
- Builds on: [ADR 143](143-seat-identity-anchored-to-workspace.md) (the discovery: Claude Code keys local-scope
  MCP config by repo root, applied then to `MUSTERD_BINDING`),
  [ADR 158](158-model-attestation-truth.md) (applied the same invariant to `MUSTERD_MODEL`; §6
  corrected by this ADR), [ADR 075](075-p3.3-cli-claim-surface-migration.md) (the agent key + grant this ADR stops
  baking), [ADR 087](087-seat-resume-vs-claim-one-verb.md) (`expired_grant` — the trap a stolen slot springs
  on wake), [ADR 155](155-human-presence-ladder.md) (driver co-presence, corrupted by the deferred
  increment 2 gap), [ADR 166](166-session-liveness-by-enumeration.md) (the same shared-slot shape on
  the session axis; its design credits this ADR's transfer argument).

## Context

Claude Code keys the local-scope MCP entry by **repo root**. Every `agents-*` seat is a git worktree
of one repo, so all of them share ONE `musterd` entry — and until this ADR, `musterd init` / `musterd
wire` baked five per-seat values into it: `MUSTERD_SERVER`, `MUSTERD_TEAM`, `MUSTERD_SURFACE`, and —
the two that matter — `MUSTERD_AGENT_KEY` and `MUSTERD_GRANT`.

Two of those are **credentials**, and the adapter's precedence ladder ranks the env **above**
`binding.json`. So whichever seat provisioned last left every sibling worktree presenting _its_
secret at claim time. Observed live 2026-07-24 in `agents-ryder` while validating ADR 158 inc 2:
`init --check` failed with "grant does not match binding.json" **by construction**, in every sibling
of whichever seat provisioned last.

The `agent_key` half is broader than the lane's original framing: the agent key is the **team**
credential, so a seat may have been _booting authenticated as a sibling_, not merely carrying a
sibling's grant into the approval lane.

### Why the old remedy made it worse

The doctor's prescription for this drift was "run `musterd init` here" — which repairs the running
seat **by stealing the slot from whoever holds it**. The previous holder then hits the ADR 087
`expired_grant` trap on wake. Zero-sum, not stale state: every "repair" created the next victim.
This is the shape that turned one worktree's provisioning into every live session on the machine
booting as `dolly` (ADR 143's incident).

## Invariant

> A config slot shared by N seats may contain only what is identical across all N. Per-seat state
> lives in the per-seat file (`.musterd/binding.json`), which the adapter finds by walking up from
> cwd.

ADR 143 established this for `MUSTERD_BINDING`; ADR 158 applied it to `MUSTERD_MODEL` (and the same
argument had earlier removed `MUSTERD_CLAIM`). `MUSTERD_GRANT` and `MUSTERD_AGENT_KEY` had the
identical stale-copy property **and** are secrets — strictly worse than the two already removed, and
still present. This ADR finishes the move.

The shape generalizes: one shared slot, many legitimate claimants, and the obvious repair — make the
slot mine — steals it from whoever holds it. The resolution is **empty the slot, not partition it**:
partitioning needs a key the writer does not have at write time (`musterd agent` cannot know which
worktree will claim), while carrying only what is identical across claimants needs no key at all,
because the per-claimant file already exists and is already authoritative. ADR 166 answers the same
shape on the session axis (`binding.session`) with the same move, and records where the transfer
stops: its per-claimant store is harness-specific, this one's (`binding.json`) is not.

## Decision

1. **`buildMcpEnv` returns `{}`.** The shared entry carries nothing. All five names remain supported
   **manual** overrides (headless/CI); provisioning simply never materializes them. The function is
   deliberately kept rather than inlined — it is the one place the rule is written down and the place
   the regression test binds. `MUSTERD_GRANT` outlived `MUSTERD_CLAIM`'s removal precisely because no
   single place recorded the rule.
2. **`musterd agent` drops `MUSTERD_SURFACE` too** (it is in `binding.json`). `MUSTERD_AUTOJOIN` and
   `MUSTERD_DRIVER` stay — deliberately, as increment 2's recorded gap (below).
3. **The doctor flags a baked secret on PRESENCE, not on mismatch.** The old grant check fired only
   on mismatch, which missed the common case: the entry is shared, so a grant matching _this_ folder
   is still the credential every sibling reads. `MUSTERD_AGENT_KEY` is now read back and flagged the
   same way. Every entry-drift remedy points at `musterd wire`.
4. **`init --check --fix` routes entry drift to `musterd wire`** — headless, no member minted, no
   bound-folder guard — and because the entry is shared, one run repairs the whole family. Full
   `runInit` remains the repair only for drift `wire` cannot fix (missing primer, hooks, guidance).
   `DoctorReport.repair: 'wire' | 'init'` carries the classification.
5. **`assertEntryIdentity` is deleted.** It compared entry secrets against binding secrets; the entry
   no longer has secrets. It was also already dead in production — see the ADR 158 correction below.

Safety rests on a pinned contract: with an **empty env**, the adapter resolves server, team, surface,
agent key and grant entirely from `binding.json` (walking up from cwd), falling back to the committed
`workspace.json` for the non-secret fields. That test exists precisely because Task 1 removed the
writer without touching the reader — if the fallback ever regresses, seats stop being able to claim
at all, and the suite says so.

### Side benefit: no more plaintext team keys in repo-tracked files

`init` builds one entry for whichever harness is chosen, and Cursor/Codex write their configs
_inside the working tree_ (`.cursor/mcp.json`, `.codex/config.toml`, both flagged via `secretPath`).
Emptying the env therefore also stops writing the plaintext team agent key into repo-tracked files
for those harnesses. `secretPath` is deliberately left in place — role provisioning still writes
other servers' credentials there.

### Correction to ADR 158 §6

ADR 158 §6 stated the doctor calls `assertEntryIdentity`. **It never did** — the doctor
re-implemented the grant comparison inline, and the `agent_key` half never ran at all. This ADR
removes the function and replaces the comparison with presence-flagging; the stale claim in ADR 158
is annotated in place.

### Deferred: increment 2 (`MUSTERD_AUTOJOIN` / `MUSTERD_DRIVER`)

Both are still baked by `musterd agent` into the shared slot and read only from `process.env`. So
`musterd agent X --driver nick` currently marks **every** worktree in the family as driven by nick —
corrupting ADR 155 driver co-presence — and forces autojoin family-wide against the tools-only
default that `wire` documents. Fixing needs new `Binding` fields plus an adapter fallback; that is
its own lane, recorded here so the gap is a decision rather than an oversight.

## Consequences

- **Provisioning any seat is now a no-op for its siblings.** The entry every seat would write is
  byte-identical, pinned by a regression test whose teeth were verified by sabotage (re-baking one
  secret fails it loudly).
- **The credential leak class is closed at the writer.** No secret in the slot means nothing to
  steal, nothing to go stale, and no `expired_grant` cascade from a sibling's repair.
- **`musterd wire` becomes the entry repair, and it repairs the family.** The doctor's prescriptions
  and `--fix` both stop routing entry drift into the harmful full-init path.
- **Existing baked entries do not fix themselves.** The strip changes what provisioning _writes_;
  entries written before it still carry secrets until a `wire`/`init` run rewrites them. The doctor
  now flags exactly this, on presence.
- **Live sessions need `/mcp` reload after the entry is rewritten** — the entry feeds process launch,
  so running MCP servers keep their old env until relaunched (the ADR 143 recovery step, unchanged).
- **The scope string stops lying.** `configure` used to claim "wired into this folder only" — the
  exact false belief ADR 143 documents. It now states the family-shared reality.
- **Increment 2's gap is live until its lane runs** (driver/autojoin family-bleed, above).

## Observability & Evaluation

**Traces** — no new instrument. The existing doctor surface (`musterd init --check`) is the sensor:
its entry-drift lines now name the exact baked variable (`MUSTERD_GRANT`, `MUSTERD_AGENT_KEY`,
`MUSTERD_MODEL`, `MUSTERD_CLAIM`) and the new `repair` field classifies every report as
`wire`-repairable or `init`-requiring, so "how many seats still carry a poisoned entry" is one sweep
of `musterd init --check --json` across the family.

**Eval** — headline: **baked-secret count across the worktree family**, measured by running the
doctor in every `agents-*` worktree. **Baseline, measured at ship time (2026-07-27, all 12 bound
worktrees + `/Users/nick/agents`): 0** — lower than the incident-era expectation of ≥1, because the
slot's last writer was `musterd agent`, which has been seat-agnostic since ADR 143 (the entry
carried only `MUSTERD_SURFACE` + `MUSTERD_AUTOJOIN`, no secrets). The zero is fragile before this
ADR: one `init`/`wire` run from any worktree would have re-baked that seat's credentials into the
slot. After this ADR the zero is structural — provisioning cannot write secrets — verified by the
byte-identical-entries regression test on every CI run. Guard metric (must not move): **claim
success from a freshly-provisioned worktree** — the empty-env fallback contract test is the proxy;
if binding-only resolution breaks, provisioning is emitting entries that cannot claim, which is a
worse defect than the one repaired.

**Experiment** — the family sweep, run at ship time: `musterd init --check --json` in every bound
worktree. Result: **no worktree classifies its drift `repair: 'wire'`** (all remaining drift is
`init`-class: the foreign-adapter staleness note — the shared entry launches
`/Users/nick/agents`' build — missing hooks, and per-seat model declarations). Consequence for the
verification as pre-registered: the before/after `wire` half was **deliberately not run** — with
zero baked secrets there is nothing for it to prove, and running `wire` from a live seat's worktree
would have _regressed_ the family (dropped `MUSTERD_AUTOJOIN` and repointed the shared adapter path
at this worktree's build). The single-run-repairs-the-family claim therefore rests on the doctor's
classification logic and its tests rather than a live demonstration; the next legacy-poisoned entry
this fleet encounters is the natural live test, and the doctor now names it on sight.

## Impact worth recording

The defect class was found by the fix's own dogfood: five defects reported in `agents-ryder`
(2026-07-24), three per-worktree and safely fixable, two shared-slot and deliberately left unfixed
because repairing them would have broken miley's live seat — which is the observation that produced
the "empty, don't partition" resolution, stanley's ADR 166 design, and this ADR.
