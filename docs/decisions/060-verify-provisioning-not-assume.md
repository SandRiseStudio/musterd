# 060 — Verify provisioning, don't assume: a self-healing onboarding hook + drift check

- Status: accepted
- Date: 2026-06-26

## Context

A new agent launched in this repo (`/Users/nick/agents`, the musterd source tree) was told by the
`SessionStart` hook "you are on a musterd team (auto-joined on launch). Run `team_inbox_check` now" —
but the `team_*` tools were absent. The hook fired on a promise the environment could not keep.

Root cause is a **decoupling between two artifacts that live in different places**:

- **The hook's trigger is a committed file marker.** The global `SessionStart`/`UserPromptSubmit`
  hooks (recipe in `docs/harness-hooks.md`) gate on `grep -q musterd:start AGENTS.md` — the primer
  marker `musterd init` writes (ADR 012). `AGENTS.md` is committed, so the marker travels with every
  checkout of the repo, onto every machine.
- **The MCP-server registration is machine-local and uncommitted.** The Claude Code adapter registers
  via `claude mcp add musterd -s local` (ADR 027), which writes into `~/.claude.json` under the current
  project — deliberately, because the entry carries the member token in plaintext and must never be
  committable (`harness.ts`). So the registration exists only on a machine where `musterd init` actually
  ran in that folder.

On any checkout where the marker is present but `musterd init` never ran (the source tree itself is the
exact case), the hook confidently claims auto-join while the tools are missing — a silent, confusing
mismatch. `claude mcp list` confirmed no `musterd` server for `/Users/nick/agents`.

## Problem

Stop the onboarding hook from asserting a team membership it hasn't verified, and make the
"marker present, server unregistered" drift **visible on demand** — without committing the token-bearing
registration and without a heavyweight provisioning daemon.

## Decision

- **The `SessionStart` hook verifies before it claims (recipe in `docs/harness-hooks.md`, and the live
  `~/.claude/settings.json`).** After the marker gate, it runs `claude mcp get musterd` (the same
  scope-agnostic check the Claude Code adapter's `detect()` already uses) from the project dir. If the
  server is registered → the existing "auto-joined" orientation. If not → it prints the **fix**
  (`musterd init` / `musterd init --check`) instead of a false reassurance. A `command -v claude` guard
  means that when `claude` isn't on the hook's `PATH` (can't verify) it falls back to the orient message
  rather than crying wolf. The hook `cd`s into `CLAUDE_PROJECT_DIR` first so the `-s local` (cwd-keyed)
  lookup resolves regardless of the hook's launch cwd.
- **`musterd init --check` is the on-demand drift detector** (`onboard/doctor.ts`,
  `inspectProvisioning(cwd)`). A **read-only checker, never a writer** — the `arch-trees:check` /
  `fmt --check` philosophy: it inspects each harness's `detect()` and the `AGENTS.md` primer class, then
  reports and exits non-zero on drift. It flags primer present but no server registered
  (the headline gap), and server registered but no primer (agents land unoriented) — and stays quiet on a
  coherently-provisioned or genuinely-unprovisioned folder. `--json` for scripts. This makes a re-run of
  `init` an _informed_ idempotent action and a stale setup self-diagnosable.
  **(Extended by PR #58 — claim value-coherence:** `claudeCode.detect()` reads back any legacy baked
  `MUSTERD_CLAIM` via `claude mcp get`, and the doctor now also flags a third kind of drift — a baked
  `MUSTERD_CLAIM` that disagrees with `.musterd/binding.json`'s `claim` — i.e. the seat the MCP `team_*`
  tools resolve ≠ the seat the CLI resolves in the same folder. Default provisioning no longer bakes the
  claim, so this catches folders still carrying an old registration; the fix it points to is re-running
  `init`.)**

## Consequences

- The silent mismatch becomes self-healing: an agent in a half-provisioned folder is told exactly what to
  run, and a human/CI can assert provisioning health with `musterd init --check`.
- The token-out-of-tree posture (ADR 027 / `harness.ts`) is preserved — nothing here proposes committing
  the registration; we close the gap by _verifying_ instead.
- Cost: `claude mcp get` adds ~1.3s at session start, but only in folders with the primer marker (the
  gate runs first), so non-musterd projects are unaffected.
- Not solved here: auto-registering the server from the committed marker (would require a secret-free,
  env-referenced entry — a separate change to the binding model). The check surfaces the drift; the human
  still runs `musterd init` to fix it. **(Since solved by ADR 080 — the committed secret-free
  `.musterd/workspace.json` launch spec + the headless `musterd wire`: a fresh clone self-wires with one
  no-prompt command, and this hook's "server not registered" branch now points at `musterd wire` when a
  committed spec is present.)**
- Composes with ADR 012 (primer marker), ADR 020 (`guard.ts` folder heuristics — `doctor.ts` is its
  read-only sibling), ADR 027 (`-s local` scope), and the `docs/harness-hooks.md` recipe.

## Observability & Evaluation

**Traces** — `init --check` is a local, read-only CLI diagnostic; it emits no coordination acts and joins
no team, so there are no new spans on the team-task timeline. The signal it produces is an exit code +
structured `--json` report (`primerManaged`, per-harness `configured`, `drift[]`) — the natural span
attributes if a future `musterd doctor` ever emits one. The hook's effect is upstream of traces: it
governs whether an agent _reaches_ the point of emitting `team_join` at all.

**Eval** — success metric: the rate of "marker present but server unregistered" sessions that an agent
reaches without being warned — target **zero** false "auto-joined" claims. **Dataset**: onboarding runs
across the provisioned-project corpus (the nine `~/.claude.json` musterd projects + fresh checkouts like
this source tree). **Baseline**: today's hook, which claims auto-join unconditionally — i.e. 100% false
reassurance in the unregistered case (the bug that prompted this ADR). The checker's own correctness is
covered by `doctor.test.ts` (both drift directions, healthy, and unprovisioned states).

**Experiment** — none built yet, but named: once batond exists, compare onboarding-to-first-`team_join`
success between the verifying hook and the old assume-everything hook across seeded fresh-checkout
sessions — does verify-don't-assume measurably cut the "agent told to use absent tools" failure (a
concrete MAST "step repetition / wrong environment" mode)?
