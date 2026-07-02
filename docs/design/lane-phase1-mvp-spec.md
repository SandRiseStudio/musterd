# Lane Phase-1 MVP — the intent + dependency layer (spec, DRAFT for review)

**Status:** ACCEPTED + IMPLEMENTED (2026-07-01) — reviewed and ADR'd as
[ADR 083](../decisions/083-lanes-phase1-intent-dependency.md) (which resolves §9's open questions), built
end-to-end (protocol + `lanes` table/migration v11 + store checks + HTTP routes + `lane_*` MCP tools +
`musterd lane`/`lanes` CLI + primer habit), and live-verified on the bravo dogfood team: the §8 scenario-1
replay produced both inline warnings and the directed wakes. Originally written fresh 2026-06-30 off the
[lanes / multi-agent-tax design arc](./lanes-and-the-multi-agent-tax.md). This is the smallest thing that
captures the biggest measured win.

**Why Phase 1 is this and only this:** the post-mortem measured ~37% of code produced as *wasted*, and
**53% of that waste was a single dependency failure** (`d08cf43`: a handshake built against a schema that
wasn't finished). The rest was duplicate lanes (handoffs that moved a *description*, not a *branch*).
Both are catchable with **declarations alone** — no file-watching, no diff analysis, **git-optional**.
So Phase 1 = the *intent + dependency* layer; observation and the symbol-level merge-funnel are Phase 2.

---

## 1. Goal & scope

**Deliver:** a first-class **lane** (owned unit of work) that agents *and* humans declare, so musterd can
**advise** (never block) on the two cheap, high-ROI signals:
1. **Unmet dependency** — you're building on a lane that isn't `done` yet (the 53% case).
2. **Surface overlap** — your declared surface intersects another active lane's (the duplicate-lane case).

Plus the mechanic that kills the biggest single loss: **handoff transfers the lane *with its branch*, not
a prose description.**

**In scope (Phase 1):** the lane object; the verbs (open/claim/board/handoff/update/resolve); declared-
surface overlap warning; dependency edges + unmet-dependency warning; the warning-delivery ergonomics;
manual resolve + (git bonus) auto-`done` on branch-merge. **git-optional throughout.**

**Out of scope (Phase 2+, explicitly do NOT build yet):** observed surface (fs-watch / `git diff`
sampling); the symbol/hunk-level merge-funnel; auto-assignment from a role pool; the full planning
hierarchy (Plan→Goal→feature); any *blocking* / gatekeeping; semantic (NLP) work-item similarity.

---

## 2. Data model

One new table, referencing existing `teams` / `members` (seats). A **project** is a surface-space scope
(reuse the ADR-068 *workspace* identity; default to the team's single project if unset).

```
Lane {
  id            ulid
  team_id       → teams.id
  project       text            -- workspace/project key; contention is scoped to this, never across
  title         text            -- the work-item (short)
  detail        text?           -- optional acceptance / notes
  owner_seat    text?           -- → members.name; NULL = open/unowned
  role          text?           -- assignment hint (backend/frontend/…), advisory only in P1
  surface_globs text[]          -- declared paths, e.g. ["packages/server/src/store/**"]
  depends_on    ulid[]          -- lane ids this lane builds on
  branch        text?           -- the git branch/artifact carrying the work (for handoff-with-branch)
  state         enum            -- open | claimed | active | blocked | done | abandoned
  created_by, created_at, claimed_at?, resolved_at?, updated_at
}
```
`surface_globs` and `depends_on` are the whole engine. Everything else is bookkeeping.

---

## 3. Verbs (MCP tools + CLI parity — follow the existing `team_*` / `musterd` dual-surface pattern)

| MCP tool | CLI | does |
|---|---|---|
| `lane_open` | `musterd lane open "<title>" [--surface <glob>…] [--role r] [--depends <id>…] [--project p] [--claim]` | create a lane (open, or `--claim` to self-own). Returns the lane **+ any warnings**. |
| `lane_claim` | `musterd lane claim <id>` | take ownership of an open lane. **Runs the contention check.** Returns warnings. |
| `lane_board` | `musterd lanes [--project p] [--mine] [--open] [--json]` | **pull** the board — lanes grouped by project with owner/state/surface/deps. The "pull, don't push" primitive. |
| `lane_handoff` | `musterd lane handoff <id> --to <seat> [--branch <ref>]` | transfer ownership **carrying the branch**. Supersedes the prose handoff for work-units. |
| `lane_update` | `musterd lane update <id> [--state s] [--surface …] [--depends …] [--block --on <id>]` | edit state/surface/deps; `--block --on` marks blocked-on-a-lane. |
| `lane_resolve` | `musterd lane resolve <id>` | mark `done` (or auto — §6). Closes the loop. |

Every mutating verb returns `{ lane, warnings: Warning[] }`. See §5 for `Warning`.

---

## 4. The two Phase-1 checks (cheap, server-side, WARN-only)

Run on `lane_open`/`lane_claim`/`lane_update` when a lane becomes/changes an **active** claim.

**(a) Unmet dependency** — the 53% case. For each `d` in `depends_on`, if lane `d`'s state ≠ `done`:
emit `Warning{kind: "unmet_dependency", subject: this.id, with: d, owner: d.owner_seat, detail: "you
are building on '<d.title>' (owner <seat>), still <state>"}`. Re-check when this lane goes `active`.

**(b) Surface overlap** — the duplicate-lane case. Intersect `this.surface_globs` against every *other*
active lane's `surface_globs` **in the same project** (glob-vs-glob overlap — a shared path prefix/match;
a cheap set operation). On non-empty overlap: `Warning{kind: "surface_overlap", subject: this.id, with:
other.id, owner: other.owner_seat, detail: "surface overlaps '<other.title>' (owner <seat>): <paths>"}`.

Both are **advisory**. Never reject the verb. (Per the arc: warn + make-visible, never gate.)

Dedup: a given `(subject, with, kind)` warns **once** until the condition clears or changes — no re-spam.

---

## 5. Warning delivery — *silent until actionable*, never a broadcast (the tricky bit)

A `Warning` reaches exactly two places, and **never** the team firehose:

1. **Inline to the actor** — returned in the response to the `lane_*` call they just made. They're
   already acting; it's the perfect, zero-extra-token moment. This is the primary channel.
2. **Directed wake to the *affected* owner** — the other party (whose lane overlaps, or whose lane is
   depended-on) gets **one directed act** (`kind: coordination`, structured meta = the Warning), routed
   through the existing wake backend: **resume the agent's loop (ADR 054) or notify the human (ADR
   024/035)** by seat-kind. Directed to 1–2 seats, not broadcast.
3. **On demand** — anyone can `lane_board` to see live contention (`warnings` annotated on lanes). Pull.

So: the actor sees it free (inline), the affected party gets a cheap targeted wake, **everyone else sees
nothing.** No status_update, no team broadcast — that's the whole point (broadcast is what we're killing).

```
Warning { kind: "unmet_dependency" | "surface_overlap", subject: lane_id, with: lane_id,
          owner: seat, detail: string }
```

Optional (nice-to-have, not MVP-blocking): a warning can be **acknowledged** (`lane_ack <id> <with>`) so
it stops re-surfacing on the board — closes the coordination loop explicitly.

---

## 6. Lifecycle & the `resolve` fix

`open → claimed → active → done` (with `blocked` and `abandoned` as side states). The measured problem
was **dead `resolve`** (2/21 loops closed) — because closing a *message thread* is a social act agents
forget. Closing a *lane* is a state transition:
- **Manual:** `lane_resolve <id>` → `done`.
- **git bonus (auto):** when the lane's `branch` merges into the project's main line, musterd
  auto-transitions it to `done` and clears its warnings. (Detected cheaply at the agent's next
  git-adjacent interaction — no watcher; Phase-2 makes this richer.) This makes closure a *fact*, not a
  courtesy.

---

## 7. How it lands additively (no flag day)

- New `lanes` table; new `lane_*` MCP tools + `musterd lane` CLI subcommands. Owner = existing seat;
  project = existing workspace; the directed wake = existing wake-on-message. **Nothing existing changes.**
- `status_update` traffic (51% of messages) can *migrate* to lane state-transitions over time (the board
  shows "lane X is done" instead of a broadcast), but Phase 1 does **not** force it — it just makes the
  board exist. Messages stay for genuine conversation (request_help/message).
- The `handoff` *act* stays for prose; `lane_handoff` is the structured, branch-carrying superset for
  work-units.

---

## 8. Acceptance scenarios (replay the measured failures — these are the DoD)

1. **The dependency-revert (`d08cf43`).** June opens lane "P3.1 schema" (surface `…/store/**`,
   `store/migrations.ts`), state active. Cleo opens lane "P3.2 handshake" `--depends <June-lane>` while
   June's lane is still `active`. → Cleo's `lane_open` returns an **unmet_dependency** warning inline;
   June gets a directed wake. **The revert never happens.** ✅
2. **The redone lane (riley≡June).** riley owns lane "BindingSchema", commits to branch `agent/riley`.
   Handoff to June via `lane_handoff <id> --to June --branch agent/riley`. June's board shows the lane
   **with the branch**; June builds on it instead of re-deriving. **No byte-identical dup.** ✅
3. **The clean independent lane (Jasmine — the control).** Jasmine opens lane "governance" (surface
   `packages/server/store/**`, `protocol/capabilities.ts`) — disjoint from every other active lane. →
   **Zero warnings.** The system stays quiet when there's no contention. ✅
4. **Cross-project non-collision.** June (project=musterd) and Cleo (project=izzocam) both touch
   `store/members.ts` → **no warning** (different projects; contention is per-project). ✅
5. **Non-git team.** All of the above work with declared `surface_globs` only; the sole thing lost is the
   auto-`done` on merge (falls back to manual `lane_resolve`). ✅

---

## 9. Open questions for the reviewing agent

- **Glob granularity / false positives.** Two lanes both declaring `packages/server/**` but editing
  different files → a warning that's technically-overlapping but harmless. P1 accepts some false positives
  (warn-not-block makes them cheap); Phase-2 observed-surface tightens it. Is declared-glob overlap
  precise enough to be *useful* rather than *noisy*? Consider: warn only on the *most specific* shared
  segment, and let owners `lane_ack` to silence.
- **Auto-claim vs. open-then-claim.** Should `lane_open` default to self-claim, keeping `open` (unowned)
  only for the future role-pool/assignment flow? (Leaning: `--claim` opt-in; unowned lanes enable Phase-2
  assignment.)
- **Dependency direction & staleness.** Re-warn cadence when a depended-on lane lingers non-`done` — warn
  once on declare + once on go-active, then rely on the board? Avoid nagging.
- **Warning ack loop.** Is explicit `lane_ack` worth the MVP complexity, or is dedup-until-cleared enough?
- **Board vs. roster.** Does the lane-board replace or augment `team_status`? (Leaning augment: roster =
  who's present; board = who owns what.)
- **Migration ergonomics.** Do we nudge agents (via the primer) to `lane_open` at task start the way we
  nudge `team_join` today — and is a lane implicitly created from a `handoff` act to ease adoption?

---

## 10. The one-sentence build order

Ship the `lanes` table + `lane_open/claim/board/handoff/resolve` + the two declared-signal checks +
inline/directed warning delivery. That's Phase 1 — **git-optional, warn-only, and it would have erased
the single largest waste in the session it came from.**
