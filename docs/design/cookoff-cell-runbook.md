# cookoff per-cell launch runbook — the setup steps each cell runs under

> **Opened 2026-07-17** (Lane `01KXS17GSZSAKA7B181DZJRD2V`, Goal cookoff-value-experiment) to
> discharge the [run manifest](cookoff-run-manifest.md) §4 "still open" item — _the per-cell setup
> runbook (clone/seed/identity/permission-policy), authored when the smoke rung runs._ The smoke rung
> is **cell D only** (manifest §2), so **cell D is specified in full below** and the other cells are
> stubbed for when the ladder resumes past the smoke check-in. Everything here inherits the manifest's
> pins (§1) unchanged — this file adds only the _mechanics_ of standing a cell up, never a new variable.
>
> **The cell-D procedure below is battle-tested** — it is the exact sequence that stood up the smoke
> cell live on 2026-07-17 against `musterd` 0.2.0 / fixture kickoff `ea5c6d4`. The `⚠` notes are the
> traps that bit during that stand-up; heed them or the cell mis-attributes commits or fails to launch.

## 0. What is identical in every cell (do not re-decide per cell)

Pulled from [manifest §1](cookoff-run-manifest.md); repeated here as the launch checklist so no cell
drifts:

- **Model** Claude Sonnet 5 (`claude-sonnet-5`) · **Harness** Claude Code `2.1.205`
- **Kickoff SHA** `ea5c6d4` (fixture `main` tip) — every clone starts detached-clean at this SHA
- **Predicate set** v1 · **Scoring tool** `musterd archaeology` from product `0.2.0` @ `481b5d1`
- **Wall-clock cap `T`** 90 min/run (proposed — the smoke cell-D build calibrates it, §4 manifest)
- **Permission policy** — one pinned Claude Code allowlist, identical across all cells (§1.5), so no
  cell pays an approval touch another cell avoids
- **Exclude globs** — frozen in the fixture's `scoring.config.json`; the runbook never edits them
- **`main` is the graded integration branch** — the fixture's own `README.md` §Workflow and
  `prompts/kickoff.md` both say _branch from `main`, merge back to `main`; its final state is what
  gets graded_. **The delivered ref is `main`.** Do not invent a separate integration branch — it
  diverges from the protocol every cell shares.

The **only** knobs the cell taxonomy turns are: musterd **present/absent**, and **N=1 vs N=3**. Cell D
is `musterd present, N=3`. Its neighbour C3 is `musterd absent, N=3` (a flat `TASKS.md` board) — the
D↔C3 delta is exactly musterd's coordination value, so the two must differ in _nothing else_. Keep the
clone, the identities, the permission allowlist, the merge mechanic, and the ticket text byte-identical
between them.

## 1. Cell D — the musterd cell (smoke rung) — full procedure

Cell D runs **three fire-and-exit Claude Code CLI sessions** (one per seat) that coordinate through a
**dedicated musterd daemon**, with the 8 tickets seeded as **Goals/Lanes** rather than a flat file.
Plain cell D is _not_ the residency variant — seats are ordinary CLI sessions, no `musterd host`, no
wake actuator. (The residency row is **D-res**, manifest §3b — defined, not authorized, out of the
smoke rung.)

Pick a run root outside the product repo (the live smoke used `~/cookoff-run`) so the fixture history
stays un-entangled from musterd's.

### 1.1 Clone the fixture — single-branch `main`, at the kickoff SHA

⚠ **The fixture's _default_ branch is `abandoned/legacy-pricing`, not `main`** — a plain `git clone`
lands on the wrong branch. The explicit `--branch main` is load-bearing. And a **full** clone would let
the fixture's `reference-solution` / `abandoned` branches into the archaeology window
(`git rev-list --all --not <kickoff>`) and count against the run, so clone **only** `main`:

```sh
# SSH deploy keys are not provisioned on the run host — clone over gh's HTTPS auth:
cd ~/cookoff-run
gh repo clone SandRiseStudio/cookoff-scenario cell-D -- --single-branch --branch main
cd cell-D
git rev-parse --short HEAD   # MUST print ea5c6d4 — fail the run if it does not
git branch -a                # MUST show only main (no scoring / no abandoned)
```

`main` is left as-is — it **is** the integration branch (§0). Do **not** cut a `run` branch.

The `scoring` branch is **never** fetched into the cell — agents must not see the hidden suites. It is
applied post-hoc from a separate checkout at scoring time (§1.7).

⚠ **pnpm baseline.** The fixture pins `pnpm@10.28` via `packageManager`; drive it through `corepack`
and set `CI=true` so it runs non-interactively (otherwise the pnpm-version mismatch tries to wipe
`node_modules` and aborts on "no TTY"):

```sh
CI=true corepack pnpm install    # esbuild's "ignored build scripts" warning is benign
CI=true corepack pnpm test       # baseline MUST be green (2 passing) before any agent touches it
```

⚠ pnpm 10.28 writes a `pnpm-workspace.yaml` build-approval file on install. It is untracked, so it
never reaches archaeology **unless an agent commits it** — add it to `.git/info/exclude` in each
worktree as a belt-and-braces guard.

### 1.2 The three seat identities (ADR 109) — set _by_ `musterd agent`, not by hand

⚠ **`musterd agent <seat>` sets the git identity for you** — but only in its **default worktree mode**.
`provisionWorkspace` (`packages/cli/src/onboard/workspace.ts`) has two paths: bare `musterd agent
<seat>` run **inside the clone** does `git worktree add -b agent/<seat>` **and** calls
`setSeatGitIdentity`; passing **`--path <dir>` makes a plain `mkdir` folder with no worktree and no
identity**. Use the bare form. The identity it writes (via `git config --worktree`, guarded by
`extensions.worktreeConfig`) is fixed by the seat name and team slug:

| musterd seat | git `user.name`      | git `user.email`        | worktree / branch          |
| ------------ | -------------------- | ----------------------- | -------------------------- |
| `dee`        | `dee (musterd seat)` | `dee@cookoff-d.musterd` | `cell-D-dee` / `agent/dee` |
| `del`        | `del (musterd seat)` | `del@cookoff-d.musterd` | `cell-D-del` / `agent/del` |
| `dot`        | `dot (musterd seat)` | `dot@cookoff-d.musterd` | `cell-D-dot` / `agent/dot` |

⚠ **`scoring.config.json` `actors` must list these exact strings** — `<seat> (musterd seat)` /
`<seat>@<slug>.musterd` — not invented emails. A commit attributed to no configured actor fails the run
(ADR 123 §2), and the identity musterd writes is what `git log` (and `musterd archaeology`) sees. ⚠ The
team **slug must be lowercase** `[a-z0-9-]` (`cookoff-d`, not `cookoff-D`) — it becomes the email
domain, so it is load-bearing for attribution.

### 1.3 Stand up the dedicated daemon + team + seats

⚠ **`musterd team create` does not isolate anything** — it writes a team row into whatever db the
ambient daemon serves. Isolation is a **dedicated db + its own daemon on its own port**
(`defaultDbPath()` reads `MUSTERD_DB`; the daemon binds `--port`), with every client pointed at it via
`MUSTERD_SERVER`:

```sh
# 1. dedicated daemon — own db, own port, background it:
MUSTERD_DB=~/cookoff-run/cookoff-d.db musterd serve --port 4870 &
export MUSTERD_SERVER=http://127.0.0.1:4870      # every CLI/MCP call below targets THIS daemon
curl -s $MUSTERD_SERVER/health                    # {"ok":true, db: …/cookoff-d.db}

# 2. team (owner = the human; owner-gated spend, manifest §2), from inside the clone:
cd ~/cookoff-run/cell-D
musterd team create cookoff-d --as nick

# 3. three seats — bare `agent`, run inside the clone → worktree + identity + MCP autojoin wiring:
musterd agent dee
musterd agent del
musterd agent dot
```

Each `musterd agent` prints `✓ workspace …/cell-D-<seat> (git worktree on branch agent/<seat>)` and
`✓ wired the musterd MCP server there for Claude Code (autojoin)`. The seats each get **their own
worktree of the fixture on branch `agent/<seat>`**, so the three agents genuinely contend on the shared
modules (`tariff.ts`, `config.ts`, `schema.ts`, `router.ts`) the trap taxonomy targets. A dedicated
team + db also keeps the run's coordination traffic out of the dogfood ledger.

### 1.4 Seed the 8 tickets as Goals/Lanes (the cell-D work artifact)

The work is held constant across cells (ADR 122): the **same `TASKS.md` text** that C3 seeds as a flat
board, cell D seeds as one Goal with a Lane per ticket carrying its contended surface. Seed from
`TASKS.md` verbatim — do not paraphrase, re-order, or add dependency hints the file does not carry (T2
must **not** name T1; T3/T4 stay independently worded). CLI syntax (`goal declare "<title>"
--goal-id`, `lane open "<title>" --surface --goal`; view with `musterd lanes` — `lane board` is
MCP-only):

```sh
musterd goal declare "Skiff — Meridian Concord fare & booking backlog" --goal-id cookoff
musterd lane open "T1 — Canonical fare quote (quoteFare)"       --surface src/tariff.ts,src/router.ts             --goal cookoff
musterd lane open "T2 — Price estimates (POST /quotes)"         --surface src/router.ts,src/schema.ts,src/tariff.ts --goal cookoff
musterd lane open "T3 — Reject malformed bookings"              --surface src/schema.ts,src/router.ts             --goal cookoff
musterd lane open "T4 — Harden the booking endpoint"            --surface src/schema.ts,src/router.ts             --goal cookoff
musterd lane open "T5 — Twilight rebate"                        --surface src/tariff.ts,src/config.ts             --goal cookoff
musterd lane open "T6 — Loyalty rebate"                         --surface src/tariff.ts,src/store.ts,src/config.ts --goal cookoff
musterd lane open "T7 — Ledger summary (GET /ledger/summary)"   --surface src/router.ts,src/store.ts,src/schema.ts --goal cookoff
musterd lane open "T8 — Configurable reach fares (GET /tariff)" --surface src/config.ts,src/router.ts,src/tariff.ts --goal cookoff
```

The lanes open **unowned** — the agents claim them. That claim/handoff/contention behaviour is the very
signal the cell measures; seeding them pre-owned would pre-answer the coordination question.

### 1.5 Pin the Claude Code permission allowlist (identical to every other cell)

The three sessions launch under one frozen allowlist so approval touches never confound the cost metric
(manifest §1, ADR 123 §5). `musterd agent` has already written a `.claude/settings.local.json` in each
worktree carrying the musterd hooks (`Notification`/`PostToolUse`/`SessionStart`/`SessionEnd`) — **merge
the `permissions` block into that file, do not overwrite it**. The pinned policy grants repo
read/edit/write + `git`/`pnpm`/`node`/`vitest` and denies network/`gh`:

```jsonc
"permissions": {
  "defaultMode": "acceptEdits",
  "allow": [
    "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite",
    "Bash(git:*)", "Bash(pnpm:*)", "Bash(pnpm test)", "Bash(pnpm typecheck)",
    "Bash(node:*)", "Bash(npx vitest:*)", "Bash(vitest:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(mkdir:*)"
  ],
  "deny": ["Bash(gh:*)", "Bash(curl:*)", "Bash(wget:*)", "WebFetch", "WebSearch", "Bash(ssh:*)"]
}
```

Keep it **byte-identical in cell D and cell C3** (its N=3 control). If an agent stalls on a missing
grant that is an `I1` intervention — the smoke run **calibrates** this list; widen it in both cells
together, never one. (Cell D additionally has the `musterd`/`team_*` MCP surface available — that _is_
the treatment, not a permission asymmetry to correct.)

### 1.6 Launch, run under the cap, capture the run window

- The task prompt is the fixture's own `prompts/kickoff.md` (identical across all cells — protocol,
  not an intervention; the `{{DISPATCH}}` block varies only in C2). Give it to each session as its
  opening message; the per-seat work then surfaces from the Goal board (`musterd next` / the lanes).
- **Branch/integration topology.** Each seat commits on `agent/<seat>`; a finished ticket integrates
  into **`main`** (the graded ref). Because `main` is checked out only in the primary `cell-D`
  worktree, the merge runs there (`git -C ~/cookoff-run/cell-D merge agent/<seat>`), serialized by the
  agents' lane coordination — that serialization _is_ musterd's measured contribution. ⚠ **The exact
  merge trigger (agent-run vs operator-run) is a shared invariant with C3** — pin the same mechanic in
  both, or the wasted-work delta is confounded.
- Record the **kickoff SHA** (`ea5c6d4`) and a wall-clock start; launch the three Sonnet-5 sessions.
- Enforce the **wall-clock cap `T`** (90 min proposed) — this is the run that _calibrates_ it, so
  **log actual time-to-done** even if under cap; that number feeds the pilot's `T`.
- Log operator interventions to `interventions.log` in the I1–I6 taxonomy (ADR 123 support metric),
  one timestamped line each, with cause.
- Keep each session's Claude Code usage `.jsonl` for the tokens-to-done roll-up.
- The **delivered ref** is `main` after all merges — that, against the kickoff SHA, is the archaeology
  window.

### 1.7 Score (no model spend — the harness is already proven, scenario doc §Validation)

From a **separate** checkout that _does_ carry the `scoring` branch (never the agents' clone):

```sh
node --experimental-strip-types score.ts --delivered main --json
```

Expect the four-metric roll-up: **headline** wasted-work % (W1–W4 + per-actor), **guardrail**
acceptance pass rate (8 hidden suites, one per ticket), **support** interventions-to-done (from
`interventions.log`), **support** tokens-to-done. The smoke gate is the reference-solution anchor
(**12.2%, non-zero, per-actor** — manifest §3, _not_ finding 001's ≈37%).

### 1.8 Smoke check-in (spend gate)

The smoke rung authorizes **cell D, 1 run** only (manifest §2). After the run: report the four metrics,
the calibrated `T`, and the tokens→billed-cost roll-up to the owner, and **stop** — the pilot rung
(A + D) is gated on that check-in. Do not roll into another cell without it.

### 1.9 Pilot-rung traps (2026-07-20, cells A1/A2/D4/D5 — finding 006)

- ⚠ **Never provision a cell while other harness sessions are live.** Claude Code rewrites
  `~/.claude.json` (and can touch seat `.claude/settings.local.json`) concurrently; last-writer-wins
  ate cell-D5's `mcpServers` entry and two seats' settings files while cell-D4's three sessions ran.
  Re-verify the MCP wiring **and** each seat's settings (gate hook marker + merged allowlist)
  immediately before launch, not at provision time.
- ⚠ **A seat's `git clean` in the shared main worktree can delete the clone's untracked
  `.musterd/binding.json`** — post-run CLI reads then need explicit `--server/--team/--as` flags.
- ⚠ Gate audit rows can attribute to the **ambient human identity** when a seat runs a gated
  command with its cwd in the shared main worktree (ADR 109-adjacent) — read `lane.gate`/
  `action.gate` actors with that in mind.
- Cell-A mechanics (now battle-tested): same clone/allowlist minus every musterd entry, git
  identity set by hand (`solo-a1 (cell A)` / `solo-a1@cookoff-a.musterd`), actor added to
  `scoring.config.json`; wrap launches in `caffeinate -i`.

## 2. Ladder-resume stubs (authored when the pilot/flagship rungs run)

These inherit §0 and mirror cell D's mechanics; the manifest names their one distinguishing structure.
Fill them in at their rung, not before (honesty rule — no apparatus authored ahead of its spend gate).

- **Cell A** — `N=1, musterd absent`. One CLI session, one git identity, `TASKS.md` flat file, same
  clone + allowlist. The single-agent control; no coordination surface.
- **Cell B** — `N=1, musterd present`. One seat on a musterd team; isolates musterd's _solo_ overhead
  (orientation/telemetry cost with nobody to coordinate with).
- **Cell C2** — `N=3, musterd absent, dispatch`. Three sessions, work handed out by an operator
  **dispatch** step rather than self-served — the "manager assigns" control. The `{{DISPATCH}}` block
  in `prompts/kickoff.md` is populated here, and each assignment is logged as an `I1`.
- **Cell C3** — `N=3, musterd absent, board`. Three sessions sharing a flat **`TASKS.md` board** (no
  Goals/Lanes, no claim/handoff primitives). **This is cell D's control** — keep clone, identities,
  ticket text, allowlist, and merge mechanic byte-identical; the only delta is the coordination layer.
- **Cell D-res** — cell D + harness residency (manifest §3b). Adds a running `musterd host`, measures
  attestation coverage / steer-lands / wake latency. Its own spend row.

## Related

[cookoff run manifest](cookoff-run-manifest.md) (the pins this operationalizes),
[cookoff scenario repo](cookoff-scenario-repo.md) (the Skiff fixture + `OPERATOR.md` clone rules),
[`cookoff-experiment.md`](cookoff-experiment.md), [`cookoff-measurement.md`](cookoff-measurement.md),
[ADR 122](../decisions/122-cookoff-value-experiment.md) (cell matrix + hold-work-constant),
[ADR 123](../decisions/123-cookoff-measurement-protocol.md) (metrics + actor-attribution rule),
[ADR 109](../decisions/109-seat-git-attribution.md) (per-seat git identity, set by `musterd agent`).
