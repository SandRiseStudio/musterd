# Model attestation — what a per-act model stamp is worth

A stamp can be an observation or a declaration, the two are not distinguishable per act, and on this team a declaration that disagrees with the runtime is normal rather than broken — so `declared ≠ observed` is the wrong alarm and `nothing ever observed this seat` is the right one.

## The ladder (ADR 101/158; falsify: read `resolveAttestation` in `packages/protocol/src/model.ts`)

Three tiers, resolved in order, highest wins:

1. **`observed`** — `binding.model_observed`, written only by the SessionStart hook via the per-harness `observeModel` probe.
2. **`environment`** — `MUSTERD_MODEL`, else the harness's own `ANTHROPIC_MODEL`.
3. **`binding`** — `binding.model`, the value baked in at provisioning (`musterd agent --model`).

Absent all three ⇒ `unknown`, which is legal and never blocks: it poisons conclusions *honestly*, so a chain with an unknown link reads "diversity unverifiable", never "diverse".

An observation is **deliberately never merged into** the declaration. `binding.ts` gives the reason: an observation that overwrote a declaration "would launder itself into one on the next session — the field's epistemic status becomes unknowable". The tiers are kept apart so the comparison between them remains possible at all.

## nick switches models mid-session, routinely (2026-08-21, stated directly by nick; falsify: find a seat whose act stamps change model family within one session while its `binding.model` never changes — if no such seat exists, switching is not happening and a declared/observed disagreement means something else)

He runs seats across different harnesses and drivers and changes the model inside a single seat's session — fable→opus and back — often. This is not derivable from the code, and it inverts how the two tiers should be read.

**Therefore `declared ≠ observed` is the expected steady state, not rot.** Do not "repair" a binding's `model` to match its observation. The declaration is a provisioning snapshot the design intends to stay a snapshot; the observation is what is running now; the ladder already prefers the observation, and the per-act stamps already track the change.

Observed instance, 2026-08-21: `miley` declared `claude-opus-5` while observing `claude-fable-5`, and its acts stamp `claude-opus-5` at `01M0JQJC8M` then `claude-fable-5` from `01M0JQRGSQ`, ~3.5 minutes apart across a session boundary. Mechanism working, end to end.

This is a claim that something is **fine**, so per [the wiki's rule 3](README.md) it carries a falsifier that can come out the other way: if the disagreement were rot rather than switching, a seat's *observed* value would hold steady across its session and only the declaration would lag. Changing act stamps within a seat are what separates the two, and they are present.

## The real gap: seats nothing has ever observed (2026-08-21; falsify: `jq '{declared:.model, observed:.model_observed.model}' <worktree>/.musterd/binding.json` per seat — an observation on gptbot or wanderer means this is fixed)

| seat | declared | observed |
| --- | --- | --- |
| dolly, izzo | `claude-opus-5` | `claude-opus-5` |
| ryder, stanley | `claude-fable-5` | `claude-fable-5` |
| miley | `claude-opus-5` | `claude-fable-5` (see above — fine) |
| **gptbot** | `claude-opus-5` | **none** |
| **wanderer** | `grok-4.6` | ~~**none** (2026-08-21)~~ OBSERVED 2026-09-03: `grok-4.6` via ADR 352's `summary.json` probe; 3 `observed` acts on revive |

Those last two attest a bare declaration. Under stable model assignment that is a decent proxy; under the switching pattern above it is a value that persists while the runtime moves out from under it. **The operating pattern makes this worse, not better** — frequent switching is exactly the condition that turns a baked declaration from "usually right" into "unverifiable and probably stale".

~~It is silent by construction: the adapter warns only when `modelSource === 'unknown'` — that is, when there is *no* model at all. A seat attesting a declaration confidently passes without comment. (Falsify: read the warn condition in `packages/mcp/src/config.ts`.)~~ **FIXED 2026-09-03** — see [the adapter now says so](#the-two-silences-at-initialize-now-speak-2026-09-03) below. (The old falsifier also pointed at the wrong file: the warn lives in `packages/mcp/src/telemetry.ts`, not `config.ts`, which is where the tier is *computed*.)

Related: `wanderer`'s `grok-4.6` declaration happens to be correct today, which is [correct by coincidence](correct-by-coincidence.md) — right until the condition nobody states stops holding.

## ~~`modelDrift` is computed and read by nothing (2026-08-21)~~ FIXED 2026-09-03 — it prints at initialize (falsify: make the assignment in `config.ts` unconditional-`delete` and run `packages/mcp packages/server packages/cli packages/protocol` — a failure outside `binding.test.ts`/`telemetry.test.ts` means something consumes it)

`resolveAttestation` returns a `drift` boolean, and `config.modelDrift` records `{declared, observed}`. It is not in the claim frame, not in any protocol frame, never reaches the server, and never renders in the CLI. Measured: with the assignment removed, **2 failed / 3784** across those four packages, both failures inside `modelDrift`'s own tests.

Given the section above this is arguably the *right* behaviour — a drift alarm here would fire on every intentional switch, and a tripwire that is noisy by design is worse than none. But it is currently an **accidental** silence rather than a decided one, and the two are worth telling apart: nothing records that the noise argument was ever made. See [instrument silence](instrument-silence.md).

**Resolved 2026-09-03 by deciding it, not by assuming it.** The noise argument was made and it lost, on one distinction: the drift warning fires **once per session at MCP initialize**, not per act. nick switching models mid-session produces at most one line per session, in the adapter's own stderr, which is the cost of a correct statement about a stale declaration — and the declaration going stale is exactly what the switching pattern guarantees. A per-act alarm would still be wrong for the reason above, and none was built.

## Why the two probed harnesses still land on a declaration (2026-08-21; falsify: for cursor, feed `musterd session observe --stdin` a payload with a new `session_id` and no model and watch `model_observed` survive — it does not)

Not a missing probe. `observeModel` exists for claude-code, cursor **and** codex, and the hooks are wired in both seats — wanderer's `.cursor/hooks.json` fires `musterd session observe --stdin` on five events, gptbot's `.codex/hooks.json` fires `musterd codex-hook post-tool-use --stdin`. They reach null by two different routes:

- **Cursor actively DROPS the observation** when a new conversation arrives carrying no model (`session.ts`, deliberate, citing ADR 268 — "a leftover observation is a stopped clock"). Reproduced on a throwaway binding: payload with `model_id` → observation written; new `session_id` with no model → `model_observed` becomes null.
- **Codex never writes one** unless PostToolUse carries `model` (`parseCodexHookEvent` returns undefined otherwise).

Both then fall through to `binding.model`. **That is the inconsistency worth naming:** the system has already ruled a stale *observation* worse than nothing, and drops it — but has never applied that judgment to a stale *declaration*, which it silently prefers as the fallback. Honest degradation degrades **into** the least-verified tier.

## What this costs the corpus — and the tier that now travels (2026-08-21; falsify: send an act from an occupancy that attested `model_source`, and read `meta.model_source` off the delivered envelope)

Per-act `meta.model` carried the model id and **not** which tier produced it, so an observed stamp and an unverified declaration were indistinguishable in the act log and any per-model aggregate mixed measurement with assumption. `modelSource` existed but reached only the once-per-session `musterd.mcp.initialize` span as `musterd.model.declaration`.

**Fixed 2026-08-21 by [ADR 301](../decisions/301-per-act-model-source-tier.md)** (nick's call: mark the tier rather than attest `unknown` — see below; land vehicle [#981](https://github.com/SandRiseStudio/musterd/pull/981), product originated on #975). The claim/heartbeat carries `model_source`, migration 42 stores it on `presence` beside `model`, and every act is stamped `meta.model_source`. Three properties are mutation-pinned: the stamp itself, the strip of a client-supplied tier, and the refusal to default an unknown tier to `binding`.

Read it as **`observed` = measurement, `environment`/`binding` = assumption**, and note that **absent is a third answer, not a synonym for declared** — rows written before migration 42, or by clients too old to send it, genuinely do not know. Aggregates over acts from before 2026-08-21 have no tier at all and cannot acquire one.

### The tier survived exactly one heartbeat (2026-09-03; falsify: `sqlite3 ~/.musterd/musterd.db "select model, model_source from presence where status='online'"` on a daemon past the fix — a live row with a model and a NULL tier means it is back)

Two weeks after ADR 301 the corpus still read as if nobody sent the tier: on revive since 2026-08-21, 2,950 acts carried a model with no `model_source` and 162 carried `observed`. wanderer read that as a collection gap and proposed making the pair mandatory on claim/heartbeat. It was not collection. Every adapter already sent the pair on both frames, and the claim path stored it — then the first 15s heartbeat re-attested the id alone: `ws.ts` called `reattestModel(db, presenceId, frame.model)` without `frame.model_source`, the store compared the pair, read `observed` → `null` as a real change, and wrote the tier to NULL. Measured: every live presence row had a model and a null tier, including seats on the newest build; 100 of 113 `observed` acts were sent within 16s of a claim against 109 of 1,324 unlabeled; the audit trail shows `occupancy.model_attested old=grok-4.6 new=grok-4.6` rows, which are this write with only the tier changing. The ADR 301 commit (`e13a79c6`) updated both claim sites and missed the heartbeat re-attest, a line from 2026-07-07.

Fixed the same day (this page's PR): the heartbeat passes the pair, and `reattestModel` treats an absent tier on an unchanged id as "no change, never a clear", the HeartbeatFrame's own contract. A tier absent on a *changed* id is still stored as null, because the old tier described a different model. The 2,950 unlabeled rows stay unlabeled: the tier they lost is not recoverable from the act log.

Two lessons for the corpus. The four-percent `observed` share was an instrument reading its own defect, not a fact about the seats, and the proposal built on it (pair-required at the protocol) would have masked the bug as a hard failure instead of surfacing it. And a "did the fix land" check for a stamped field has to read the field *after* the steady-state path has run, not at the moment the write happens; the ADR 301 tests read the stamp before any heartbeat.

### Why not attest `unknown` instead (nick's decision, 2026-08-21)

The tidier-looking fix — a seat whose probe produced nothing attests `unknown` rather than its declaration — was rejected, and the reason is worth recording because it is not obvious. `wanderer` is the **only non-claude family among live agents**. Its `grok-4.6` is an unverified declaration, so attesting `unknown` would flip the ADR 101 family posture from `diverse` to `monoculture` — a change in the team's stated decorrelation basis driven by a *measurement gap*, not by any change in who is actually working. Marking the tier keeps the information and labels its strength instead of discarding it. [research-corpus](research-corpus.md) records that the per-model leaderboard's remaining blocker is **N**; the sharper statement is that **N is not uniform in quality and nothing marks which rows are which** — and under frequent switching that matters more, not less.

## The two silences at initialize now speak (2026-09-03; falsify: launch an adapter on a probe-capable surface with only `binding.model` set and no `model_observed`, and read its stderr — no warning means this regressed)

Both silences above lived at one seam, `recordAdapterInitialization` in `packages/mcp/src/telemetry.ts`, and both are now warnings. Neither blocks; ADR 101's posture is unchanged.

1. **A declaration where an observation was reachable.** `unknown` was loud and `observed` is right; the case in between said nothing. `shouldWarnUnobservedModel` (in `packages/protocol/src/model.ts`, beside the ladder so the CLI and the adapter cannot disagree) is true when the resolved tier is `binding` or `environment` **and** the surface is one whose harness declares an `observeModel` probe — `claude-code`, `codex`, `cursor`, `grok`, `opencode`. The warning names the declared value, the tier and the surface, and prescribes `musterd wire` + a new session.
2. **The drift tripwire prints.** `config.modelDrift` is computed at boot and on every heartbeat refresh, and until this change nothing read it (2026-08-21; falsifier in the section above); it is now one stderr line naming declared vs observed.

**Probe-capability is read off `config.surface`, never off MCP `clientInfo`.** That is ADR 120's rule, and here it has teeth rather than being a comment: the surface is what the launcher marker resolved (ADR 286), while `clientInfo` is a string the client picks for itself, and a client that called itself `claude-code` could otherwise talk musterd into an accusation about a probe it does not have. `telemetry.test.ts` pins the distinction with a config whose `clientInfo` says Cursor and whose surface says `cli` — and asserts silence.

The surfaces with no probe (`cli`, `web`, `ios`, `slack`, `other`, `musterd`) stay silent deliberately. A declaration is the honest best they can do, and warning at a session that cannot act on the warning is how a useful signal becomes noise that gets filtered.

What this does **not** fix is the gap two sections up: gptbot and wanderer land on a declaration because cursor drops a model-less observation and codex only writes one when PostToolUse carries `model`. The warning makes that visible in the affected session for the first time — it does not make the probe produce anything. Expect it to fire on exactly those seats, which is the point.
