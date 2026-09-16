# Workspace self-heal — a stale seat repairs itself at session start and says so on every inbox check

**Date:** 2026-09-16  
**Status:** proposed  
**Lane:** `01M2NV5JNYAJ89HP11VFCW16MQ` (izzo)  
**Scope:** design only; implementation follows an approved plan. Increment 3 adds one daemon route (the repair audit row — there is no client-facing audit write today; `audit` is written only by server handlers, and the sole client surface is the admin `GET /teams/:slug/audit`), so it carries an ADR under `change-adr:check`. Increment 4 (the inbox-check field) is adapter-only.

## Outcome

A seat whose workspace has fallen behind what the installed `musterd` build writes — guidance files,
harness hooks — is repaired at its next session start without anyone running a command, is told in
one line what changed, and can see on any inbox check afterwards whether it is behind again. The two
classes of drift that a hook must not repair on a seat's behalf — the harness permission floor, and
any file outside the seat's own worktree — stay a human's command, and the same line names them.

Every repair is an audit row on the daemon, so "why did this seat's hooks change" is answerable from
the log rather than from a transcript.

## Why

Measured 2026-09-16 on the hub laptop (izzo, on nick's word). Seven of nine seat worktrees were on
stale guidance — dolly, ghost, miley, ryder at v22, big-body v20 and v21, kimi v18 with two files
never written at all — against a current v23. The v23 line they were missing is *"an accept on a
review ask IS the verdict"*, which had by then closed three lanes unreviewed, one of them
`stakes: high` (sloane, lane `01M2NRA59J`). After guidance was refreshed on six seats, five of them
also had stale or missing hooks: the OpenCode doorbell plugin was absent on ghost and big-body, so
nothing had been probing their interrupt line at any tool boundary; kimi's Claude Code PostToolUse
interrupt hook was on an old build; and four seats were missing `mcp__musterd` from the ADR 261
permission floor, which fails a non-interactive session closed on the tool it needs most.

All of this while `runSessionProbe` (`packages/cli/src/onboard/doctor.ts:1239`, the `--check-build`
flag every SessionStart hook runs) had been printing the exact repair commands at every one of those
seats' session starts. Detection is not the defect. Three things are:

1. **The line is advisory.** It says "run these three commands" to an agent that is mid-orientation
   with a few hundred unread acts. The census says the command is not run.
2. **It fires once.** A session that stays up for two days is never re-checked, and the ADR 152
   auto-refresher moves `main` under it several times a day.
3. **It is dropped.** The sibling build-skew warning on the inbox-check reply is computed on every
   call and thrown away by a structured-first harness (stanley, lane `01M2NRYJEQ`). Anything that
   rides the same text channel has the same fate.

## Approaches considered

- **A — repair at SessionStart, keep printing to hook stdout.** Smallest change; inherits defects 2
  and 3 whole.
- **B — repair at SessionStart, deliver drift on the inbox-check seam.** A plus the delivery fix,
  on a seam stanley is already repairing. Its one protocol edge is the audit-row route, not a new
  drift concept on the daemon. **Chosen.**
- **C — daemon-side drift record.** Seats attest a provisioning generation on join; the daemon
  computes drift against main's build and pushes it through the interrupt line; the roster shows
  fleet-wide drift. Most complete, but a protocol change and an ADR, and it makes provisioning a
  daemon concern where today it is deliberately a per-workspace one. Deferred: once B writes an
  audit row per repair, the fleet view is a query, and C can be a later increment on top.

## The security line

Self-heal is a propagation accelerator. The trust anchor is already `main`: the SessionStart hook
runs arbitrary code from the shared `/Users/nick/agents` checkout, which ADR 152 pulls from `main`
on a ~10-minute settle, and every installed hook shells out to that build. A compromised build
already owns every seat. Self-heal does not widen *who* is trusted; it shortens the window between
"landed on main" and "running on every seat" from *next reprovisioning* to *next session start* —
for a fix and for an attack alike.

Two things it would widen, and this design refuses both:

| class | self-heals? | reason |
| --- | --- | --- |
| **guidance** — `.musterd/skill/*`, `.claude/commands/*`, `.cursor/rules/*`, and the rest `inspectArtifactDrift` names | **yes** | musterd-owned content, stamped with a content version, reviewed on `main` under ADR 109 attribution; ADR 161 already documents `--refresh-guidance` as safe in a live workspace (no prompts, no mint, no binding rewrite) |
| **hooks** — marker-owned entries in `.claude/settings.local.json`, `.cursor/hooks.json`, `.grok/hooks/musterd.json`, `.opencode/plugins/musterd.js` | **yes, in-worktree only** | marker-owned, merged never clobbered, and ADR 168's two-way epoch verdict refuses to write an older hook over a newer one |
| **hooks outside the worktree** — today Codex's `.codex/hooks.json` in the git common dir | **no** | codex-cli reads the common-dir copy (`harnesses/codex.ts:477`), so it is one text for every seat of the repo. One seat's SessionStart rewriting every seat's harness is a cross-seat write; it belongs to the auto-refresher, which already owns the shared checkout (increment 5) |
| **permissions** — the ADR 261 floor | **no** | the harness's own security boundary. A floor change reviewed once on `main` is not a capability chosen for this seat. Stays exactly as today: one line naming `musterd init --refresh-permissions` |

Four guards, each reusing something that exists:

- **Kill switch.** A `self-heal` key in the existing `.musterd/declined.json` — the file that already
  records a declined hook — disables repair for that folder. Detection and the line are unaffected.
- **Checkout-behind.** ADR 168's verdict "the hook is newer than this checkout — do not run init or
  every folder on the machine is downgraded" applies to self-heal verbatim. If the epoch on disk is
  newer than the build's, repair is skipped and the line says so.
- **Atomic write.** Every file the repair touches is staged, validated (JSON parses; the marker set
  is exactly what the build writes), then renamed over the original. The backup `--refresh-hooks`
  already takes is kept. This matters more than it did: a malformed write from a hook bricks the
  *next* session start silently, and there is no human at the keyboard to notice.
- **Attribution.** One audit row per repair on the daemon: seat, counts repaired per class, what was
  skipped and why (declined / checkout-behind / outside-worktree / permissions), the build that did
  it. Written through a new lease-authenticated `POST /teams/:slug/workspace/repair` that the handler
  records as `workspace.repaired` via `appendAudit` — best-effort on the client, same contract as
  every audit write: never a gate, never blocks the session, a dead daemon is silence.

Guidance is model-read instruction, and self-heal removes the last human step between a guidance
change on `main` and every seat following it at its next start. That is accepted on purpose: the
control is the same PR review and attribution that governs every other change to `main`, and the
alternative — the census above — is that corrections to the guidance reach almost nobody.

## Section 1 — The SessionStart repair path

`runSessionProbe` stays the entry point and the flag stays `--check-build`. ADR 171's own reasoning:
behaviour that lives in the CLI reaches every seat whose hook is already installed; behaviour placed
in the hook *string* reaches only seats that re-run provisioning. So this ships with no hook-text
change and no `FEATURE_EPOCH` bump.

One new step between "inspect" and "print":

1. `inspectArtifactDrift(cwd)` as today → `{ guidance, hooks, permissions }`.
2. If `declined.json` carries `self-heal`, or the epoch verdict is checkout-behind → skip to 5.
3. `runRefreshGuidance(cwd)`, then `runRefreshHooks(cwd, { withinWorktreeOnly: true })`. The new
   option makes `refreshHooks` skip any harness surface whose resolved path is outside `cwd` and
   report it as skipped rather than write it. Both functions gain the atomic-write path; nothing
   else about them changes, and the manual `musterd init --refresh-*` commands keep their current
   behaviour (a human running `--refresh-hooks` still refreshes the common-dir copy).
4. Re-inspect. Whatever is still drifted after repair — permissions always; the common-dir Codex
   hooks when they were stale — is what gets reported. A repair that leaves drift must show it.
5. Emit the audit row (best-effort) and print the line.

Output contract unchanged and load-bearing: **silent when clean, always exit 0, never throws, one
bounded line.** The line's shape changes from a prescription to a report — see Section 3.

## Section 2 — The recurring detection seam

Provisioning drift is inspected once per session today; the build-skew check runs on every
`team_inbox_check`. They become one surface.

- `inspectArtifactDrift` gains a cached, throttled variant. Result written to `.musterd/drift.json`
  as `{ inspected_at, build, guidance, hooks, permissions }`. Re-inspected when the cache is older
  than 10 minutes — the auto-refresher's settle period, so drift cannot change faster than `main`
  does — or immediately when the daemon's `/health.build` differs from the cached `build`, because a
  bounce is exactly the moment guidance on disk may have gone stale. Inspection is a filesystem walk
  of a few dozen small files; the cache exists so an inbox check never pays it twice in a window.
- The MCP adapter's inbox-check handler, at the two places `buildSkewWarning` is already called
  (`packages/mcp/src/tools/inboxCheck.ts:405`, `:506`), also reads the cached drift and places the
  result in `structuredContent.workspace`:

  ```json
  {
    "workspace": {
      "build": { "adapter": "fb283e5c", "daemon": "65df087b", "stale": true },
      "provisioning": {
        "guidance": 15, "hooks": 3, "permissions": 1,
        "repairable_at": "session-start",
        "declined": false
      }
    }
  }
  ```

  Absent entirely when clean, so a structured-first harness renders nothing rather than an empty
  object. This is the canonical shape stanley's lane `01M2NRYJEQ` renders; that lane fixes the
  channel (a `content[].text` warning a structured-first harness drops), this one fills it.
- Nothing mid-session repairs. A running harness cannot hot-swap its own hooks, and a guidance file
  rewritten under a live session is the hazard ADR 161 already avoids. The recurring seam *tells*;
  SessionStart *does*.

## Section 3 — What the agent sees

Three moments, three lines, all bounded to one line each:

1. **SessionStart, after repair** (hook stdout, lands as `SessionStart hook additional context`):
   `musterd: repaired 15 guidance files and 3 hooks (v22→v23, e19→e20); permissions still behind —
   run \`musterd init --refresh-permissions\`.` When nothing needed repair: silence, the current
   contract. When repair was declined or blocked by the checkout-behind verdict: the line says which,
   and falls back to today's prescription.
2. **Any inbox check, when drifted:** `workspace: guidance stale (v23 → v24 landed 14:02Z) — repairs
   itself at your next session start.` The agent's one actionable choice is whether to end the
   session now; the line makes clear the cost of not doing so is nothing until then.
3. **Any inbox check, when the adapter is stale:** `buildSkewWarning`'s existing text, now rendered
   via stanley's fix. Unchanged here.

The audit row makes moment 1 visible beyond the seat: `musterd status` can show a seat's last
self-heal (increment 4 or a follow-up), and the human can answer "why did dolly's hooks change" from
the log.

## Section 4 — Ownership of the one excluded hook surface

Codex's `.codex/hooks.json` in the git common dir is refreshed today by any seat that runs
`--refresh-hooks` (observed 2026-09-16: refreshing miley wrote
`/Users/nick/agents/.codex/hooks.json`). Under self-heal it is skipped and reported. Its owner
becomes the ADR 152 auto-refresher: on the bounce that follows a `main` move, it runs the Codex
common-dir install through the same epoch guard. That is one actor, already trusted with the shared
checkout, writing the one file that is shared by construction — instead of whichever seat starts a
session first.

## Testing

- **Unit, `doctor.test.ts`** — self-heal runs when drift is present and not declined; skips on
  `declined.json` `self-heal`; skips on the checkout-behind verdict and says so; permissions are
  never written; a surface resolving outside `cwd` is skipped *and reported*, never swallowed; the
  post-repair re-inspect is asserted (a repair that leaves drift shows it in the line); the audit row
  carries the right counts and reasons; a daemon that is down does not fail the session start.
- **Atomic write** — a fixture whose staged JSON fails validation leaves the original file
  byte-identical and the backup untouched.
- **Adapter, `inboxCheck.test.ts`** — `structuredContent.workspace` present and correct with drift,
  absent when clean; the cache is honoured inside the window and invalidated by a daemon build
  change.
- **Live, before increment 3 merges** — one seat worktree left deliberately at v22; a fresh session
  started; the repair line observed in `SessionStart hook additional context`; the audit row read
  back from the daemon; `musterd init --check` clean afterwards. That measurement goes in the wiki,
  dated, with the seat named. It is the thing the 2026-09-16 census showed nobody had.

## Increments

1. This spec.
2. Implementation plan (`superpowers:writing-plans`).
3. SessionStart self-heal + audit row (`doctor.ts`, `init.ts`, the harness `refreshHooks`
   implementers for the `withinWorktreeOnly` option and atomic write; plus the one daemon route and
   its ADR — the route is the only protocol edge in this design).
4. `structuredContent.workspace` on inbox check (adapter only; coordinated with `01M2NRYJEQ`).
5. Codex common-dir refresh moves to the auto-refresher's bounce step.

## Out of scope

- Repairing the harness permission floor automatically. Decided against above.
- Any write outside the seat's worktree from a seat's hook. Decided against above.
- A daemon-side drift record or fleet view (approach C). Deferred; the audit row is its input.
- Converting a v2 provisioning manifest (`musterd harness configure`). That is a choice of harness
  set for a seat, not drift, and stays a human's command.
- Hot-swapping hooks or guidance under a live session.

## Related

- ADR 135 (build provenance), 152 (auto-refresh), 161 (refresh-guidance is live-safe), 168 (hooks
  are content; the two-way epoch verdict), 171 (check against the template, not the receipt — and
  why the flag stays `--check-build`), 261 (the permission floor), 333 (orient skill everywhere).
- Lanes `01M2NRYJEQ` (stanley — the stale-adapter warning is dropped before the seat sees it),
  `01M2NRA59J` (sloane — a guidance fix is not delivered; this spec is the provisioning owner its
  second half asked for).
- `docs/wiki/the-instrument-discharges-the-act.md` — the adjacent lesson that a check which is also
  the delivery cannot be used to measure delivery; the audit row here is the same remedy applied to
  provisioning.
