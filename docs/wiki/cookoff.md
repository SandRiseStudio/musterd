# Cookoff — the value experiment's standing rules and apparatus traps

The sell is D-vs-uncoordinated-N, NEVER D-vs-solo — flagship measured D vs C3 at the same 100 % correctness with 1.9 % vs 72.2 % wasted work (~38×), while solo A wins cost AND wall-clock (D burns ~7.7× solo's tokens), so A is the honest denominator and the cost objection is real.

## Where the substance lives (pointers, not duplication)

Design: ADR 122/123 + docs/design/cookoff-experiment.md, cookoff-measurement.md, cookoff-scenario-repo.md. Results: docs/research/006 (enforcement induces coordination — 8/8 lanes claimed in every enforced cell vs 0/8 guidance-only) and 007 (compliance under deny — Gate B answered unconfounded 2026-08-01: 2/2 denies HELD, zero route-arounds, guard intact; no further paid GB run warranted absent design change). Founding research: docs/design/research-foundation.md (Co-Gym — the turn-taking ablation, 30 % vs 70 %, is the number that justifies the notification protocol). The ~37 % uncoordinated-waste baseline: docs/design/lanes-and-the-multi-agent-tax.md (finding 001).

## Apparatus traps (all hit live, 2026-07-20 → 2026-08-01)

- **Launching 12 seats + 6 daemons at once CRASHED the machine** — relaunch staggered (3 waves of 4). See [nicks-laptop](nicks-laptop.md).
- **Each cell needs its own `git clone --single-branch --branch main`** — archaeology's window is `--all --not <kickoff>`, so the reference/abandoned branches pollute the score otherwise.
- **Never isolate a headless cell via `CLAUDE_CONFIG_DIR`** — it breaks headless auth (the OAuth token lives in the Keychain, which a relocated config dir cannot read). Run under default config; register cell MCP via `claude mcp add -s local`.
- **The unreachable-human arm is a presence wipe monitored via sqlite ONLY** — any nick-authed CLI/HTTP read re-creates presence and un-does the arm.
- **Provisioning a cell while other harness sessions run clobbers `~/.claude.json` mcpServers** (last-writer-wins) — re-verify immediately pre-launch.
- score.ts flags need zsh word-splitting (`${=var}`); guardrail keys are `acceptancePassRate` + `perTicket`.

## Ladder status (2026-08-31)

Smoke + pilot + flagship (A / B / C2 / C3 / D) are **done** — the N comparison is finding 006, and the per-cell launch procedures are in `docs/design/cookoff-cell-runbook.md` §2 (filled from `~/cookoff-run/flagship/`, not invented). Remaining unauthorized: **D-res** (manifest §3b, defined) and **cell E**.

## Open thread

Cell E ("task too big for solo" — the one experiment that could change the regime the headline applies to) is DESIGN IN PROGRESS as of 2026-08-03; every settled decision and the open arms/replicates question live in `~/cookoff-run/e-ladder/HANDOFF.md` — read it before resuming, do not re-litigate what it records. A no-spend apparatus check (T9–T12 hidden suites + delivery-curve scorer) is at `~/cookoff-run/e-ladder/e1-apparatus-check.md`. **nick 2026-08-31: hold E** — do not open a launch procedure or a spend row in this lane. The standing sell rule survives cell E regardless of outcome.
