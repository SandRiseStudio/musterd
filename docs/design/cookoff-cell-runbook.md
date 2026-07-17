# cookoff per-cell launch runbook — the setup steps each cell runs under

> **Opened 2026-07-17** (Lane `01KXS17GSZSAKA7B181DZJRD2V`, Goal cookoff-value-experiment) to
> discharge the [run manifest](cookoff-run-manifest.md) §4 "still open" item — _the per-cell setup
> runbook (clone/seed/identity/permission-policy), authored when the smoke rung runs._ The smoke rung
> is **cell D only** (manifest §2), so **cell D is specified in full below** and the other cells are
> stubbed for when the ladder resumes past the smoke check-in. Everything here inherits the manifest's
> pins (§1) unchanged — this file adds only the _mechanics_ of standing a cell up, never a new variable.

## 0. What is identical in every cell (do not re-decide per cell)

Pulled from [manifest §1](cookoff-run-manifest.md); repeated here as the launch checklist so no cell
drifts:

- **Model** Claude Sonnet 5 (`claude-sonnet-5`) · **Harness** Claude Code `2.1.205`
- **Kickoff SHA** `ea5c6d4` (fixture `main` tip) — every clone starts detached-clean at this SHA
- **Predicate set** v1 · **Scoring tool** `musterd archaeology` from product `0.2.0` @ `481b5d1`
- **Wall-clock cap `T`** 90 min/run (proposed — the smoke cell-D build calibrates it, §4 manifest)
- **Permission policy** — one pinned Claude Code allowlist, identical across all cells (§3 below), so
  no cell pays an approval touch another cell avoids
- **Exclude globs** — frozen in the fixture's `scoring.config.json`; the runbook never edits them

The **only** knobs the cell taxonomy turns are: musterd **present/absent**, and **N=1 vs N=3**. Cell D
is `musterd present, N=3`. Its neighbour C3 is `musterd absent, N=3` (a flat `TASKS.md` board) — the
D↔C3 delta is exactly musterd's coordination value, so the two must differ in _nothing else_. Keep the
clone, the identities, the permission allowlist, and the ticket text byte-identical between them.

## 1. Cell D — the musterd cell (smoke rung) — full procedure

Cell D runs **three fire-and-exit Claude Code CLI sessions** (one per seat) that coordinate through a
**running musterd daemon**, with the 8 tickets seeded as **Goals/Lanes** rather than a flat file. Plain
cell D is _not_ the residency variant — seats are ordinary CLI sessions, no `musterd host`, no wake
actuator. (The residency row is **D-res**, manifest §3b — defined, not authorized, out of the smoke
rung.)

### 1.1 Clone the fixture — single-branch, at the kickoff SHA

A full clone would let the fixture's `reference-solution` / `abandoned/legacy-pricing` branches land in
the archaeology window (`git rev-list --all --not <kickoff>`) and count against the run. Clone
**only** `main`:

```sh
git clone --single-branch --branch main \
  git@github.com:SandRiseStudio/cookoff-scenario.git cell-D
cd cell-D
git rev-parse HEAD          # MUST print ea5c6d4… — fail the run if it does not
git checkout -b run         # agents branch/merge on top of this; kickoff stays pinned
pnpm install && pnpm test   # baseline must be green before any agent touches it
```

The `scoring` branch is **never** fetched into the cell — agents must not see the hidden suites. It is
applied post-hoc from a separate checkout at scoring time (§1.7).

### 1.2 Configure the three seat git identities (ADR 109)

Each cell owns its own actor identities; a commit attributed to no configured actor **fails the run**
(ADR 123 §2). Cell D's three seats — pin these into the cell's `scoring.config.json` `actors` list
before launch (they are cell-D's own identities, **not** the fixture's `alix`/`boro`/`cyra`
validation seats):

| Seat  | git `user.name` | git `user.email`               | musterd seat |
| ----- | --------------- | ------------------------------ | ------------ |
| ded-1 | `cookoff-d-1`   | `cookoff-d-1@sandrise.invalid` | `dee`        |
| ded-2 | `cookoff-d-2`   | `cookoff-d-2@sandrise.invalid` | `del`        |
| ded-3 | `cookoff-d-3`   | `cookoff-d-3@sandrise.invalid` | `dot`        |

Each seat's worktree carries its own `git config user.name/email` (ADR 109 per-worktree identity), so
`Co-authored-by` trailers survive the squash-merge and `musterd archaeology` attributes lines to the
right actor. Wire these via `musterd agent <seat> --path <worktree>` per seat so the binding and the
git identity are set together.

### 1.3 Stand up the musterd team + daemon

```sh
musterd team create cookoff-D          # fresh team, its own daemon/db — isolated from the dogfood team
musterd agent dee --path ./seats/dee   # provisions worktree + git identity + binding, per seat
musterd agent del --path ./seats/del
musterd agent dot --path ./seats/dot
musterd status                          # 3 seats present, none working yet
```

Isolation matters twice over: (a) a dedicated team keeps the run's coordination traffic out of the
`revive` dogfood ledger, and (b) each seat gets its **own worktree of the `run` branch** so the three
agents genuinely contend on shared modules (`tariff.ts`, `config.ts`, `schema.ts`, `router.ts`) the way
the trap taxonomy intends.

### 1.4 Seed the 8 tickets as Goals/Lanes (the cell-D work artifact)

The work is held constant across cells (ADR 122): the **same `TASKS.md` text** that C3 seeds as a flat
board, cell D seeds as one Goal per ticket with a Lane carrying its contended surface. Seed from
`TASKS.md` verbatim — do not paraphrase, re-order, or add dependency hints the file does not already
carry (T2 must **not** name T1; T3/T4 stay independently worded):

```sh
musterd goal declare cookoff --title "Skiff — Meridian Concord fare/booking backlog"
# one lane per ticket; surface globs are the ONLY structure musterd adds over the flat board
musterd lane open --goal cookoff --title "T1 canonical quoteFare"            --surface src/tariff.ts
musterd lane open --goal cookoff --title "T2 POST /quotes price estimate"    --surface src/router.ts,src/schema.ts,src/tariff.ts
musterd lane open --goal cookoff --title "T3 reject malformed bookings"      --surface src/schema.ts,src/router.ts
musterd lane open --goal cookoff --title "T4 harden the booking endpoint"    --surface src/schema.ts,src/router.ts
musterd lane open --goal cookoff --title "T5 twilight off-peak rebate"       --surface src/tariff.ts,src/config.ts
musterd lane open --goal cookoff --title "T6 tiered loyalty rebate"          --surface src/tariff.ts,src/config.ts,src/store.ts
musterd lane open --goal cookoff --title "T7 GET /ledger/summary"            --surface src/router.ts,src/store.ts,src/schema.ts
musterd lane open --goal cookoff --title "T8 configurable reach fares + GET /tariff" --surface src/config.ts,src/router.ts,src/tariff.ts
```

The lanes are opened **unowned** — the agents claim them. That claim/handoff/contention behaviour is
the very signal the cell measures; seeding them pre-owned would pre-answer the coordination question.

### 1.5 Pin the Claude Code permission allowlist (identical to every other cell)

The three sessions launch under one frozen allowlist so approval touches never confound the cost
metric (manifest §1, ADR 123 §5). The allowlist grants exactly:

- repo read / edit / write **within the cell clone only**
- `git`, `pnpm`, `node`, `vitest`

and grants **no** network, no `gh`, no shell outside those tools. Ship it as the cell's
`.claude/settings.json` `permissions.allow` list, byte-identical in cell D and cell C3. (Cell D
additionally has the `musterd`/`team_*` MCP surface available — that _is_ the treatment, not a
permission asymmetry to correct.)

### 1.6 Launch, run under the cap, capture the run window

- Record the **kickoff SHA** (`ea5c6d4`) and a wall-clock start; launch the three sessions, each
  claiming its seat (`musterd claim <seat>` on first tool call) and pulling work from the Goal board.
- Enforce the **wall-clock cap `T`** (90 min proposed) — this is the smoke run that _calibrates_ `T`,
  so **log the actual time-to-done** even if it runs under cap; that number feeds the pilot's `T`.
- Log operator interventions to `interventions.log` in the I1–I6 taxonomy (ADR 123 support metric) as
  they happen — one line per intervention, with timestamp and cause.
- Keep the Claude Code usage `.jsonl` for each session for the tokens-to-done roll-up.
- The **delivered ref** is the `run` branch tip after all merges — that, against the kickoff SHA, is
  the archaeology window.

### 1.7 Score (no model spend — the harness is already proven, scenario doc §Validation)

From a **separate** checkout that _does_ carry the `scoring` branch (never the agents' clone):

```sh
node --experimental-strip-types score.ts --delivered <run-branch-tip> --json
```

Expect the four-metric roll-up: **headline** wasted-work % (W1–W4 + per-actor), **guardrail**
acceptance pass rate (8 hidden suites, one per ticket), **support** interventions-to-done (from
`interventions.log`), **support** tokens-to-done. The smoke gate is the reference-solution anchor
(**12.2%, non-zero, per-actor** — manifest §3, _not_ finding 001's ≈37%).

### 1.8 Smoke check-in (spend gate)

The smoke rung authorizes **cell D, 1 run** only (manifest §2). After the run: report the four metrics,
the calibrated `T`, and the tokens→billed-cost roll-up to the owner, and **stop** — the pilot rung
(A + D) is gated on that check-in. Do not roll into another cell without it.

## 2. Ladder-resume stubs (authored when the pilot/flagship rungs run)

These inherit §0 and mirror cell D's mechanics; the manifest names their one distinguishing structure.
Fill them in at their rung, not before (honesty rule — no apparatus authored ahead of its spend gate).

- **Cell A** — `N=1, musterd absent`. One CLI session, one git identity, `TASKS.md` flat file, same
  clone + allowlist. The single-agent control; no coordination surface.
- **Cell B** — `N=1, musterd present`. One seat on a musterd team; isolates musterd's _solo_ overhead
  (orientation/telemetry cost with nobody to coordinate with).
- **Cell C2** — `N=3, musterd absent, dispatch`. Three sessions, work handed out by an operator
  **dispatch** step rather than self-served — the "manager assigns" control.
- **Cell C3** — `N=3, musterd absent, board`. Three sessions sharing a flat **`TASKS.md` board** (no
  Goals/Lanes, no claim/handoff primitives). **This is cell D's control** — keep clone, identities,
  ticket text, and allowlist byte-identical; the only delta is the coordination layer.
- **Cell D-res** — cell D + harness residency (manifest §3b). Adds a running `musterd host`, measures
  attestation coverage / steer-lands / wake latency. Its own spend row.

## Related

[cookoff run manifest](cookoff-run-manifest.md) (the pins this operationalizes),
[cookoff scenario repo](cookoff-scenario-repo.md) (the Skiff fixture + `OPERATOR.md` clone rules),
[`cookoff-experiment.md`](cookoff-experiment.md), [`cookoff-measurement.md`](cookoff-measurement.md),
[ADR 122](../decisions/122-cookoff-value-experiment.md) (cell matrix + hold-work-constant),
[ADR 123](../decisions/123-cookoff-measurement-protocol.md) (metrics + actor-attribution rule),
[ADR 109](../decisions/109-seat-git-attribution.md) (per-seat git identity).
