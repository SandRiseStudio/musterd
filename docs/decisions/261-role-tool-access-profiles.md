# 261 — Roles carry a tool-access profile, and provisioning compiles it

- Status: proposed
- Date: 2026-08-13
- Owner: stanley
- Relates to: ADR 026/027/028 (role templates, additive provisioning, the built-in seed), ADR 063 (observer members), ADR 144 inc 5 (`scopeToolSurface` — capabilities scope the MCP surface), ADR 150 (the lane-surface PreToolUse write gate), ADR 171 (provisioning freshness: `--check` / `--refresh-hooks`), ADR 227 (roles & stewardship, multi-role seats), ADR 255 (read→merge→write on concurrent config saves), ADR 260 (live acceptance pick skips busy agents)

## Context

On 2026-08-13 ryder was blocked for hours: `Write` denied on `docs/wiki/*` in a non-interactive session. musterd was innocent. Lane `01KZWR684C` owned surface `["docs/wiki/**"]`, so the ADR 150 gate allowed the write. The denial came from the **harness** permission layer — the seat's `.claude/settings.local.json` carried hooks and **no `permissions` block at all**. A non-interactive session cannot prompt, so it fails closed, correctly, and presents as a broken tool. nick unblocked it by hand.

There are three permission layers, and musterd owns only two:

| Layer                           | Mechanism                                        | Owner      |
| ------------------------------- | ------------------------------------------------ | ---------- |
| capabilities → MCP tool surface | `scopeToolSurface` (`packages/mcp/src/scope.ts`) | musterd    |
| lane surface → file writes      | ADR 150 PreToolUse hook                          | musterd    |
| harness allow/ask/deny          | `.claude/settings.local.json`                    | **nobody** |

They compose as **AND**. So drift in the third always fails closed, and always misattributes — the agent, the human, and the logs all blame the layer that was innocent.

The third layer exists in code but is not owned. `role.tools.permissions` is parsed today, and `provisionRoleTools` (`packages/cli/src/onboard/init.ts`) does merge it into `.claude/settings.local.json` through `claudeCode.provision`. But it only fires in **interactive `init` with a role template chosen**; `generalist` — the default — declares no permissions; `musterd agent <seat>` never provisions any; and ADR 171 freshness covers hooks only. Every seat's allowlist is therefore an accident of which prompts a human happened to approve. stanley and miley have long accumulated lists. izzo and ryder had none.

## Problem

A seat's ability to do its job depends on an unowned, invisible, per-machine artifact that provisioning never writes and never checks. The failure is silent, misattributed, and only reachable by hand.

## Decision

**A role carries a tool-access profile, and provisioning compiles it into the seat's harness settings.** The harness block becomes a compiled artifact, never hand-maintained.

1. **The profile lives on the role** (ADR 227), alongside the existing `tools.permissions`. Observer members (ADR 063) are the read-only precedent. Named archetypes — `read-only`, `read+write`, `bash-only` — are a seed of examples, not a catalog (ADR 028); a role may spell its own lists.

2. **A ceiling needs `deny`, not just `allow`.** Allow cannot subtract, and in Claude Code `deny` outranks `allow` and cannot be overridden interactively. `read-only` compiles `deny: [Write, Edit, NotebookEdit]` plus `Bash` (or `Bash` narrowed to read-only commands); `bash-only` denies `Edit`/`Write`. The existing merge is additive-only ("not a clamp", ADR 026 §4); the ceiling is the part that clamps, and it clamps through `deny`.

3. **One role definition drives both musterd-owned layers.** The same profile feeds `scopeToolSurface`: a read-only role drops `lane_claim`/`lane_submit` from the MCP surface _and_ denies `Write` at the harness. The two layers cannot drift from each other because there is one source.

4. **ADR 150 stays the finer gate, within the ceiling.** Ceiling = "may this seat write at all", static per role. Lane surface = "here, now", per claim. This composition is deliberate, not redundant.

5. **Freshness extends to the compiled block.** ADR 171 `--check` / `--refresh-hooks` reports and repairs a missing or stale permissions block exactly as it does a missing hook. **Role reassignment recompiles** — including the roster-home `musterd role assign` path, a known trap that un-mutes and re-roles a seat and would otherwise skip the refresh.

6. **Merge, never clobber** (ADR 255-shaped read→merge→write). All hook groups and every entry outside the profile's own vocabulary survive a recompile, mechanically — the shape of nick's manual unblock (scoped allow, five hook groups preserved) is what a recompile must produce on its own.

7. **User-accumulated allows that exceed the ceiling are NOT stripped; they are reported.** "Ceiling" argues for stripping, but stripping deletes entries a human approved at a prompt, silently, on a schedule the human did not choose — reintroducing the misattributed silent failure this ADR exists to end. Instead: `deny` entries are authoritative and always written (a real ceiling — `deny` beats `allow` regardless of what else is in the file), while surplus `allow` entries are left in place and surfaced by `--check` as drift for a human to resolve. A profile that must truly forbid something states it in `deny`.

8. **Interaction with ADR 260 / the quiet-set arc.** A read-only role cannot accept lanes, so it must not appear in `pickReviewCounterpart`'s candidate pool — the profile changes what "eligible" means on the acceptance path, and an unspendable candidate is the ADR 260 failure in a new costume. Surfaces do not collide (this ADR: `packages/cli/src/onboard/**`; the quiet-set arc: `packages/server/src/store/review.ts`) but the designs must agree: **eligibility must read the profile, not just presence.** Named here so it is decided out loud rather than discovered; wanderer owns the change on their side.

**Boundary that holds.** Do **not** gate `Write`/`Edit`/`Bash` via MCP capabilities. Harness-native tools deny before musterd is consulted. The compiled settings block and the ADR 150 hook are the only mechanisms that reach them.

## Consequences

Provisioning gains write authority over a file humans also edit, which is why §6 and §7 are conservative: musterd owns `deny` and its own entries, and reports the rest. A seat whose role declares nothing keeps today's behaviour except that it now gets a **baseline** allow block, so a fresh non-interactive seat can do the work its lane already authorises — the concrete ryder fix.

Roles stop being a charter-plus-MCP-servers convenience and become load-bearing for what a seat can do. Getting a profile wrong now blocks a seat rather than merely mislabelling it, which is an argument for the freshness check being loud, and for `--check` to name the layer: the whole cost of the original incident was three hours spent looking at the wrong one.

## Observability & Evaluation

**Traces.** `--check` reports a permissions-block finding distinct from hook drift (layer named in the message). Provisioning records the compiled block in the ADR 030 manifest as it already records permissions, so `unprovision` stays an exact reversal. A recompile on `role assign` logs what it changed.

**Eval.** The measurable claim is narrow and falsifiable: **no seat is blocked by a missing harness permission again.** Count, per seat, non-interactive sessions that end with a harness-layer permission denial. Baseline is not zero — ryder's incident is one, and it cost hours; it is also the only one anybody noticed, so the honest reading is that the counter has never been instrumented and silence is not evidence (ADR 259 inc 3). Instrument first: a denial that nobody records is the exact failure mode being fixed.

Secondary, and the one that would indict this ADR: **recompiles that remove something a seat needed.** Any `--check` finding of surplus `allow` is a case where a human approved something the profile did not anticipate. A steady stream of those means the profiles are wrong, not that the humans are.
