# 326 — Session orientation: the injected block, the orient ritual, and the scoped wake

- Status: accepted (Decision 2 amended 2026-08-27 — owed reviews and routed acceptances are
  **tier 1**, taken up unprompted; tier 2 is only unaddressed work. Read the 2026-08-27 amendment
  below before acting on Decision 2 or its "autonomous pickup is deliberately excluded" clause.)
- Date: 2026-08-25
- Builds on: [ADR 049](049-orientation-and-handoff.md) (the orientation brief),
  [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (composable-only injected context),
  [ADR 093](093-persistent-seat-memory.md) / [ADR 259](259-memory-git-truth-derived-indexes.md)
  (seat memory), [ADR 131](131-harness-residency-wake-ledger-host.md) (residency + wake),
  [ADR 209](209-portable-wake-context.md) (the wake-context packet this finally wires in),
  [ADR 212](212-standing-context-budget.md) (standing-context budget),
  [ADR 233](233-owed-reviews-in-the-brief.md) (owed reviews)
- Design: docs/superpowers/specs/2026-08-25-session-orientation-design.md
- Lane: 01M039T0RBBWAD85M6VQFKDRZC

## Context

The human has been the go-between: every new session in a seat workspace started blind until nick
typed "continue from last session"; the seat's own `team_memory_save` wrap-up note was rendered
only by `team_join`, which the primer discourages, so on the ordinary autojoin path the headline
was never shown. The SessionStart hook's "run team_inbox_check now" is an instruction the model
may skip — and the label-sweep episode measured exactly that: a one-shot SessionStart ask was
skipped under a busy first prompt for days, while a per-turn nudge that repeats until a stamp
lands is the variant that actually happens. Meanwhile `team_wake_context` (ADR 209) was built,
authorized, and named by no guidance surface at all.

## Problem

1. How does a human-opened seat session start *already oriented* — memory headline, waiting acts,
   incidents, owed reviews — with zero model compliance required?
2. How does it then *act* on the urgent subset unprompted, with the proven compliance pattern?
3. What does a *woken* session get, so its bounded errand is not drowned in a team-wide brief?

## Decision

1. **The orientation block (injected, human-opened sessions).** `musterd session start --stdin` —
   the project-local SessionStart capture hook's command — emits a bounded orientation block after
   capture; the hook one-liner stops redirecting stdout (capture itself still prints zero). The
   block obeys the ADR 088 composable-only bar: act enums, validated seat slugs, ULIDs, counts,
   ages. Message bodies and lane titles never appear; unrenderable fields are dropped, not
   escaped. The one free-text field is the seat's OWN memory headline, flattened, bounded
   (≤120 chars), and fenced as `<<headline-as-data: …>>`. Read-only (no cursor advance, no seat
   claim), ≤15 lines, silent on any failure, and suppressed under `MUSTERD_PROVENANCE=wake`.
2. **The orient ritual (acted, nudged until stamped).** A `musterd-orient` skill: inbox check
   (the autojoin moment), memory read, **handle tier 1 unprompted** — directed asks awaiting this
   seat's reply, open incident lanes — then **surface tier 2** (owed reviews, carried lanes,
   up-next) without acting, one status_update, then `musterd session orient-stamp`. The stamp is
   workspace-local and keyed by the captured session id — orientation is a property of the
   session, not the machine — and quiets a per-turn `musterd session orient-nudge` line carried by
   the machine-wide SessionStart and UserPromptSubmit hooks. Autonomous pickup of new work is
   deliberately excluded; a future policy flag owns moving that line (spec §E).
3. **Wakes stay scoped.** The daemon-composed wake lines now name `team_wake_context`
   first, and the tool joins `SKILL_MCP_TOOLS`. A woken session gets its errand (the ADR 209
   packet: wake kind, objective, lane/thread state, memory headline, explicit reads) — never the
   team-wide block, which its provenance suppresses.
4. **Distribution.** All emission logic is CLI-side; the capture-hook and machine-hook text
   changes ride the existing ADR 171 drift repair and ADR 168 equal-epoch overwrite — no
   feature-epoch bump. Claude Code first (it has the hook seams); Codex has no SessionStart
   injection point wired and opencode has no hook table (ADR 321 §8), so those seats keep the
   primer text and the improved wake line until an adapter grows the seam.

## Consequences

- A seat session opened by a human starts knowing its headline, what waits, and what it owes —
  and the repeating nudge drives it to answer directed asks and triage incidents unprompted.
- "Continue from last session" stops being a human ritual; the falsifier is nick typing nothing.
- The wake path and the open path stop sharing one blunt pointer: broad block for humans' sessions,
  scoped packet for wakes.
- A compromised predecessor session can still write a hostile memory headline for its successor;
  the fence, flattening, and length cap bound that residual, and it is this seat's own field —
  teammate-authored free text stays out of injected context by construction.
- **2026-08-27 — Decision 2's tier split is superseded in part.** Its "surface tier 2 (owed
  reviews…) without acting" and "autonomous pickup of new work is deliberately excluded" are both
  amended by the 2026-08-27 amendment below: owed reviews and routed acceptances are tier 1 and are
  taken up unprompted, and the excluded category is *unaddressed* work. The Decision text itself is
  left verbatim because `change-adr:check` freezes the `## Decision` of an accepted ADR — the
  inline-marker convention of ADR 160 predates that gate and no longer passes it, so the pointers
  live here and on the Status line (the ADR 056 form) instead. The design spec carries the same
  markers at §A(2) and §B step 4, where they are permitted.

## Observability & Evaluation

**Traces.** The orientation block and nudges are hook-riding CLI output and add no daemon traffic
beyond three existing authenticated reads (inbox, next, memory envelope) per session start —
visible in the daemon's request log under the seat's identity. The orient stamp
(`.musterd/orient-stamp.json`) records `oriented_at`; stamp age minus capture `started_at` is the
time-to-orient measure.

**Eval.** Unit: composer rejects hostile headline/name/id inputs (planted-string assertions), caps
at 15 lines, returns null on empty; emission is silent under wake provenance, without a bound
seat, and on fetch failure; stamp keyed to the captured session id re-arms on a new capture; wake
lines name `team_wake_context` (server tests). Baseline: before this ADR, zero sessions
oriented without a human prompt, and `team_wake_context` had zero callers.

**Experiment.** The live falsifier (spec §Testing): open a session in a seat workspace and type
nothing — the agent must greet oriented, directed asks answered, incidents triaged, nudge quiet by
turn two. If the human still types "continue from last session", the design failed regardless of
test greenness.

## Amendment — 2026-08-26: the block is agent-facing; the chip is the user-facing half

**Lane:** 01M0Y2PFQCY117KRGM4SKZE722

The live falsifier above ran on 2026-08-26 in the `dolly` seat and returned a **split result**, which
is more useful than either a pass or a fail.

The agent half passed exactly as designed: the block generated, and the session opened by reading it,
running the orient ritual, and clearing five stale `daemon_down` asks unprompted — before the human
had said anything about them. The human half failed completely. Nick opened the terminal, saw a blank
screen, and reported "nothing happened."

Both are true because **the orientation was only ever addressed to the agent**, and this ADR did not
notice it was making a promise to a second audience. The Claude Code hooks contract gives
`SessionStart` no user-facing seam at exit 0:

> `SessionStart` doesn't use the standard decision model. Exit code 2 shows stderr to the user only;
> it doesn't block anything. JSON output is discarded entirely.
>
> | `systemMessage` | **Discarded.** Use `additionalContext` instead |

So stdout and `additionalContext` both land in model context, and `systemMessage` — the field that
surfaces a line to the human on nearly every other event — is dropped on this one. No formatting
change to the block could have fixed this; the seam does not exist.

**What changes.** Nothing about the block, which was right. This ADR's claim about who sees it was
wrong, and the §Experiment falsifier above should be read as testing the agent behaviour only.

**What is added.** A project-local `statusLine` seat chip (`musterd session statusline`), rendering
`🔶 seat · team · ⚑n waiting · lane: …`. It is visible with zero typing, persists for the session
instead of scrolling past, and redraws as the inbox changes. The chip composes counts and validated
slugs and carries **no free text at all** — stricter than the block, which fences one field (the
seat's own memory headline): a surface that redraws every turn is a worse host for attacker-controlled
bytes than a one-shot block.

**Rejected: `SessionStart` exit 2 → stderr.** It is the one documented path to the terminal at session
start, and it would have matched the original promise most literally. It was rejected because it
inverts musterd's never-failing hook contract — every hook we ship ends `|| true` precisely so a
coordination failure can never disturb the session riding it — and because the harness is free to
style exit-2 stderr as a hook error, which would make a routine greeting look like a broken install.

**Scope.** Claude Code only, like the hooks: it is the harness with the seam. The chip is
project-local, not machine-wide, because a chip names ONE seat — a shared slot would stamp this seat's
name onto every terminal on the laptop. `installMusterdStatusline` refuses to overwrite a `statusLine`
musterd did not write and returns a warning instead: there is exactly one such slot per settings file,
so installing over a user's own is unrecoverable, unlike hooks, which coexist as a list.

**Falsifier for this amendment.** Open a session in a seat workspace and type nothing: the chip must
name the correct seat for THAT workspace (not the ambient cwd's) before the first prompt, and must
render nothing at all — never an error — in a folder with no binding or with the daemon down.

### 2026-08-27 — distribution moved to ADR 333

Decision (4) said Claude Code first, and that Codex had no SessionStart injection point. That
clause is superseded by [ADR 333](333-orient-skill-every-harness.md): the skill is cataloged on
every supported harness; Cursor `sessionStart` and Codex `SessionStart` inject the block (we had
been discarding that stdout); Codex also gets the repeating `orient-nudge` on UserPromptSubmit.
OpenCode stays catalog-only. The ritual, the composable-only bar, and wake-suppression above are
unchanged.

## Amendment — 2026-08-27 (UTC): tier 1 is everything addressed to the seat

Live observation (nick, across co-driven sessions; insight in team memory): seats surfaced
acceptance and review requests routed to them and then asked the human's permission to take them.
That is not model timidity; it is compliance with this ADR's own ritual, which placed owed reviews
in tier 2 ("surface, do not handle") and closed with "stop and wait for direction". The behaviour
trains users to stay inside co-driven sessions answering questions the protocol already answered —
the opposite of the target mode (a human works their own lane and is interrupted only by what
routes to them; see `docs/design/2026-08-26-musterd-user-agent-flow.md`).

Two data points from the ledger, both `2026-08-27 01:0x UTC` (2026-08-26 evening local — the dates
differ by zone, and the acts are the authority):

1. **A seat declined addressed work on session-management grounds, then reversed on a human's
   word.** `01M10BX9651` — stanley declining a review routed to it ("this seat is wrapping in the
   next minute…") at 01:03:50, then `01M10C0449` taking the same review at 01:05:24 once the human
   spoke. Its own orientation status one minute later, `01M10BYFH5` (01:04:30), does not mention the
   review at all: the seat had disposed of an addressed act and its readout showed no trace of it.
2. **The request left the open-action list the moment it was answered, before any review
   existed.** Both replies above name `01M10BS69Q` in `meta.in_reply_to`, and both carry the same
   `from_member` — one seat, not two. ADR 254 discharge is written by the **answering act**, not by
   the work being done, so "taking it" reads as "settled" to every addressee including the taker.
   Nothing in `openActionNeeded` distinguishes *answered* from *done* — the mechanical half that
   guidance cannot reach (dolly's lane `01M0ZDKXPJ` / #1088).

   Falsifier: `select id, from_member, act, json_extract(meta,'$.in_reply_to') from messages where
   json_extract(meta,'$.in_reply_to')='01M10BS69QYFMJH1VKCQT0VXB4'` — two rows, one member. A row
   from a second member would falsify this reading.

**The autonomy line moves to where it always belonged: between ADDRESSED and UNADDRESSED work, not
between answering and doing.** Decision 2 is amended: tier 1 is everything addressed to this seat —
directed asks, incidents, **and acceptance/review requests routed to it, which the seat takes up
unprompted**. Tier 2 — surfaced, never acted on — is work nobody routed to the seat: carried lanes,
up-next, claimable open lanes. §E's exclusion of autonomous pickup now reads "unaddressed work"; a
directed acceptance was never optional, so taking it is not an autonomy expansion.

**The dedup step this makes load-bearing.** A `request_help` carries an eligible set of 2–4 names
(ADR 254). While each addressee only *surfaced* it, the human arbitrated and duplication was bounded;
telling every addressee to execute unprompted removes that bound, and the only mechanism left is
ADR 254 discharge — which `packages/server/src/store/messages.ts` populates **only** from an
`accept`/`decline` whose `meta.in_reply_to` names the request. A review delivered any other way (a
plain `message`, a forge comment, or work done before the request act existed) discharges nothing.
So the ritual gains one clause, and it is not optional: **announce with `team_send {act:'accept',
reply_to:<the request act id>}` before starting.** `packages/mcp/src/tools/send.ts` maps `reply_to`
→ `meta.in_reply_to`, the exact key the store reads, so the announcement *is* the discharge for
every co-addressee at once. This is the guidance half; #1088 is the surface half, and they are
complementary.

Shipped as guidance v20 (`renderOrientSkill`), with a behavioural test pinning the claim and the
snapshot discipline carrying the bump. The §Experiment falsifier gains two cases: a seat that
orients onto a waiting review request and asks the human whether to take it, and two seats that
review the same request because neither announced it.
