# 408 — A stale workspace repairs itself at session start, and the repair is an audit row

- Status: proposed
- Date: 2026-09-16
- Relates to: [ADR 171](171-provisioned-workspace-currency.md) (check against the template, not
  the receipt — and why the SessionStart flag stays `--check-build`), [ADR 168](168-hook-content-drift.md)
  (hooks are content; the two-way epoch verdict this decision inherits), [ADR 161](161-init-defaults-to-the-folders-team.md)
  (`--refresh-guidance` is safe in a live workspace), [ADR 261](261-role-permission-profiles.md)
  (the permission floor this decision refuses to touch), [ADR 152](152-daemon-auto-refresh.md)
  (the auto-refresher, which owns the shared checkout and inherits the shared Codex hooks),
  [ADR 135](135-build-provenance-every-runtime.md) (the build stamp the audit row carries),
  [ADR 391](391-refused-interrupt-probe-attribution.md) (the precedent: "who was refused" is
  recorded on the interrupt route; "who was repaired" is its symmetric half)
- Spec: `docs/superpowers/specs/2026-09-16-workspace-self-heal-design.md`
- Lane: `01M2NV5JNYAJ89HP11VFCW16MQ`

## Context

Measured 2026-09-16 on the hub laptop (izzo, on nick's word): seven of nine seat worktrees were on
stale guidance — v18 to v22 against a current v23 — and the v23 line they were missing is *"an
accept on a review ask IS the verdict"*, which had by then closed three lanes unreviewed, one of
them `stakes: high`. After guidance was refreshed on six seats, five also had stale or missing
hooks: the OpenCode doorbell plugin was absent on two, so nothing had been probing their interrupt
line at any tool boundary; one seat's Claude Code PostToolUse interrupt hook was on an old build;
four were missing `mcp__musterd` from the ADR 261 floor.

All of it while `runSessionProbe` — the `--check-build` flag every SessionStart hook runs — printed
the exact repair commands at every one of those seats' session starts. Detection was never the
defect. The line is advisory and the census says the command is not run; it fires once, and the
auto-refresher moves `main` under a long session several times a day; and its sibling build-skew
warning was, until #1479, dropped by structured-first harnesses.

## Problem

A correction to guidance or a hook lands on `main` and reaches almost nobody, because the last step
— a human or a seat running `musterd init --refresh-*` in every worktree — is the step nobody takes.
The cost is not cosmetic: a seat on stale guidance follows an instruction the team has already
found to be wrong, and a seat with a stale interrupt hook is deaf on a build the team believes is
ringing.

The obvious remedy, "have the hook repair it", has a security shape that must be decided rather
than drifted into. Self-heal is a propagation accelerator. The trust anchor is already `main`: the
SessionStart hook runs arbitrary code from the shared checkout ADR 152 pulls every ~10 minutes, and
every installed hook shells out to that build, so a compromised build already owns every seat.
Self-heal does not widen *who* is trusted; it shortens the window from *next reprovisioning* to
*next session start* — for a fix and for an attack alike. Two things it *would* widen, and this
decision refuses both.

## Decision

1. **The SessionStart probe repairs before it reports.** `runSessionProbe` (`--check-build`) now
   inspects, repairs, re-inspects, and prints one line saying what it did and what it left. The
   flag keeps its name so this reaches every seat with no hook-text change and no `FEATURE_EPOCH`
   bump (ADR 171's own reasoning: behaviour in the CLI reaches every installed hook; behaviour in
   the hook string reaches only seats that re-provision). Its contract is unchanged: silent when
   clean, always exit 0, never throws, one bounded line.

2. **What self-heals, and what never does.** Guidance files and marker-owned hooks **inside the
   seat's own worktree** are repaired. Two classes are not, by policy:
   - **The ADR 261 permission floor.** It is the harness's own security boundary; a floor change
     reviewed once on `main` is not a capability chosen for this seat. It stays exactly as today —
     a line naming `musterd init --refresh-permissions`.
   - **Any write outside the worktree.** The machine-wide Claude Code settings and Codex's
     git-common-dir `hooks.json` (which codex-cli reads in a worktree) are one file for every seat.
     A hook in one seat's session must not rewrite them. `refreshHooks` gains `withinWorktreeOnly`,
     under which such a write is *skipped and named*, never made. A human's `--refresh-hooks` still
     writes them; the shared Codex copy becomes the auto-refresher's on its bounce (increment 5).

3. **Four guards, each reusing what exists.** A `musterd:self-heal` tombstone in
   `.musterd/declined.json` switches repair off for a folder (detection and the line are
   unaffected). ADR 168's checkout-behind verdict — an installed hook stamped by a *newer* build —
   skips repair and says the checkout, not the hook, is behind. Every file written goes through
   `writeJsonAtomic`: stage, validate, rename, because a malformed write from a hook bricks the
   next session start with nobody at the keyboard. And every repair is attributable — decision 4.

4. **The repair is an audit row.** A new route, `POST /teams/:slug/workspace/repair`, authenticated
   by the **seat credential alone** — no session lease, no presence touch — records
   `workspace.repaired` via `appendAudit` with the
   `WorkspaceRepairBody`: the build that did it, counts repaired per class, what was skipped and
   why (`declined` / `checkout_behind` / `outside_worktree` / `policy`), and what remains. Counts
   and classes only; the schema has no field for a file's contents. Best-effort on the client: a
   dead daemon is silence, never a failed session start. This is the design's only protocol edge.

   Leaseless on purpose, and this is the one exception to ADR 337's rule that agent HTTP proof is
   inseparable from its Presence lease. The SessionStart hook posts this *before* the session has
   joined — the ADR 164 window in which every lease-gated route is refused, measured on the
   interrupt probe — so a lease requirement would refuse every real post (the first draft of this
   decision required one; the live arm's write-up predicted the 401 and nick chose the correction
   the same evening). The repair is local and the credential hash alone proves whose workspace it
   was; a lease would prove nothing extra. `authMember` takes `{ leaseless: true }` from exactly
   this route and nowhere else.

5. **Drift is cached by the CLI and read by the adapter** (increment 4). `.musterd/drift.json` is
   refreshed on the interrupt-check cadence — at most every 10 minutes, or immediately when the
   daemon's build changes — and the MCP adapter surfaces it as `structuredContent.workspace`
   beside the `warnings` #1479 made renderable. Mid-session it only *tells*; SessionStart *does*. A
   running harness cannot hot-swap its own hooks, and a guidance file rewritten under a live
   session is the hazard ADR 161 already avoids.

## Consequences

- Guidance is model-read instruction, and this removes the last human step between a guidance
  change on `main` and every seat following it at its next start. Accepted on purpose: the control
  is the same PR review and ADR 109 attribution that governs every other change to `main`, and the
  alternative — the census above — is that corrections reach almost nobody.
- The human loses a per-seat approval step for guidance and in-worktree hooks, and keeps it for
  permissions and every cross-seat write. The audit row means "why did this seat's hooks change" is
  answerable from the log rather than from a transcript.
- One agent route accepts a seat credential without a lease. Its blast radius is one audit row of
  counts and classes under the seat's own name; it cannot read, send, claim, or move anything.
- `runRefreshHooks` returns `{ code, files, skipped, refused }` instead of a number and takes
  `quiet`; the CLI command reads `.code`. Every harness's `refreshHooks.run` returns `skipped`.
- A daemon-side fleet view of drift (approach C in the spec) is deferred; once every repair is an
  audit row, that view is a query, not a new protocol concept.
- Not repaired, ever, by this path: the permission floor; the machine-wide Claude Code settings;
  Codex's common-dir hooks; a v2 provisioning manifest (`musterd harness configure` is a choice of
  harness set, not drift).

## Observability & Evaluation

- **Unit.** `atomicWrite.test.ts` (a failing validator leaves the original byte-identical);
  `refreshHooks.test.ts` (`withinWorktreeOnly` skips and names the machine-wide settings;
  `checkoutBehindHooks` true on a newer epoch in either file, false on absent/unparseable);
  `selfHeal.test.ts` (repairs guidance and hooks, never permissions; declined and checkout-behind
  repair nothing and say why; an outside-worktree skip is reported and counted as remaining; a
  throwing refresh never escapes); `doctor.test.ts` (the probe prints the outcome line, posts the
  row, and exits 0 with the daemon down); `workspace-repair-http.test.ts` (one row per post, 401
  without a lease, 400 on a malformed body).
- **Live, before increment 3 merges.** One seat worktree deliberately left one guidance stamp
  behind; a fresh session; the repair line observed in `SessionStart hook additional context`; the
  `workspace.repaired` row read back from the daemon; `musterd init --check` clean afterwards.
  Recorded, dated and seat-named, in `docs/wiki/workspace-self-heal.md`.
- **Falsifier for the policy line.** Leave a seat's `.claude/settings.local.json` one floor entry
  short, start a session: the entry must still be absent afterwards and the line must name
  `--refresh-permissions`. If the entry appears, decision 2 has been crossed.
