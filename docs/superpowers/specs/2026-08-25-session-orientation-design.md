# Session orientation — the digest, the ritual, and the scoped wake

- Date: 2026-08-25
- Lane: 01M039T0RBBWAD85M6VQFKDRZC ("Orient on every new session vs continue same session")
- Participants: nick (design conversation), dolly (author)
- Related: ADR 049 (orientation brief), ADR 088 (injection bar), ADR 093/259 (seat memory),
  ADR 131 (harness residency), ADR 167 (session-messaging rail), ADR 209 (portable wake context),
  ADR 212 (standing-context budget), ADR 233 (owed reviews), standing-context spec 2026-08-03

## Problem

Nick is still the go-between. Every new session in a seat worktree starts blind until he types
"continue from last session" or pastes the tail of the previous one; agents check their inbox when
told to; a seat's own wrap-up note — faithfully saved via `team_memory_save` every session — is
never surfaced to the next occupant, because the headline is rendered only by `team_join`
(`packages/mcp/src/tools/join.ts:52-56`) and the primer tells agents *not* to call `team_join`
(autojoin claims silently on the first `team_*` call). The SessionStart hook's one-line
"run team_inbox_check now" is an instruction the model must choose to obey, and the label-sweep
episode measured exactly that shape failing: a one-shot SessionStart ask was skipped under a busy
first prompt for 3 days, while a per-turn, due-gated nudge that repeats until a stamp lands is the
variant that actually happens (`packages/cli/src/onboard/harnesses/claudeCode.ts:270-277`).

Target behavior, decided in conversation:

1. A human-opened session in a seat worktree **orients itself and handles anything urgent**
   without being prompted, then waits for direction.
2. **Urgent, tier 1 (handle now):** directed asks awaiting this seat's reply, and open
   `kind:incident` lanes. **Tier 2 (surface prominently, do not auto-handle):** owed reviews
   (ADR 233). Everything else is reported, not acted on.
3. A **woken** session stays scoped to its errand — no broad team digest.
4. Autonomous resume-of-work ("claim the next lane unprompted") is explicitly deferred.

## Design overview

Three mechanisms, one per failure mode:

| Mechanism | Failure it closes | Compliance needed |
|---|---|---|
| A. Injected digest | starting blind | none — data arrives in opening context |
| B. Orient ritual (skill + repeating nudge) | urgent items not acted on | model action, driven by the proven repeat pattern |
| C. Scoped wake via `team_wake_context` | woken sessions over- or under-oriented | model action, pointed at by the wake line |

## A. The digest — SessionStart injection, human-opened sessions

The project SessionStart hook already runs `musterd session start --stdin`. That CLI handler
gains digest emission — a **CLI-side change, so the hook text is untouched and no feature-epoch
bump or fleet re-provision is needed** (the same placement argument that put `--check-build`'s
probe CLI-side, `packages/cli/src/onboard/doctor.ts:932-936`).

Content, in order, all derived from the daemon's typed API:

```
musterd digest — seat "dolly" on team "revive" (read-only; nothing marked read, seat not claimed)
memory (saved 20h ago, 312 bytes): <<headline-as-data: 2026-08-25 wrap: guardian #1047 …>>
waiting: 2 directed acts — ask from stanley (01M0…), handoff from miley (01M0…)
incidents: none
owed reviews: 1 — lane 01M0… (waiting 3h)
carrying: 1 lane in flight (01M0…)
orient now: run the musterd-orient skill — reply to the directed acts and triage incidents first.
```

Rules:

- **Composable-only (ADR 088 bar, inherited verbatim):** act enums, validated seat slugs, ULIDs,
  counts, ages. Message bodies, lane titles, and any teammate-authored free text never appear —
  they arrive only through governed tools as tool-result data.
- **The one free-text field** is the seat's own memory headline (≤120 chars, enforced at save).
  It is self-authored but could have been poisoned by a compromised prior session, so it renders
  inside explicit `<<headline-as-data: …>>` delimiters, never as an imperative, with the
  data-not-instructions framing the memory system-reminders use.
- **Read-only and non-mutating:** no inbox cursor advance, no seat claim, no presence write. The
  existing hook invariant holds — hooks tell, they never do (`claudeCode.ts:246-249`). The
  read path reuses the `musterd nudge` precedent (read-only peek at directed acts for the
  folder's bound seat, `packages/cli/src/commands/nudge.ts:6-35`).
- **Bounded:** ≤15 lines, hard-capped; on daemon-unreachable or unbound folder it emits nothing
  (silent, exit 0 — `runSessionProbe`'s contract).
- **Suppressed when `MUSTERD_PROVENANCE=wake`** (set by the wake actuator,
  `packages/cli/src/host/pinnedBin.ts:186-196`): woken sessions get mechanism C instead.

## B. The ritual — `musterd-orient` skill + repeating due-gated nudge

A new generated skill (rendered from `packages/protocol/src/guidance.ts` like
`musterd-nudge-relay`), whose steps are:

1. `team_inbox_check` — first `team_*` call, so this is also the autojoin/claim moment.
2. `team_memory_read` when the digest showed a headline.
3. **Handle tier-1 urgent:** reply to each directed ask/request_help/steer waiting on this seat
   (`accept`/`decline`/answer as the act demands); open incidents get triaged — read the incident
   lane, post a status_update with what was found, do not silently start unrelated work into a
   shared red.
4. **Surface tier 2 and the rest to the human:** owed reviews with ages, carried lanes, up-next —
   one compact readout, no action.
5. `team_send {act:'status_update'}` — one line — then stamp oriented.
6. Stop and wait for direction. (The autoresume ratchet lives here later; see E.)

The nudge: a per-turn line emitted by the CLI —
`musterd: unoriented seat session — run the musterd-orient skill now.` — due-gated exactly like
the label nudge (`labelSweepDue()`, `packages/cli/src/commands/session.ts:919-928`), except the
stamp is **per session**, not machine-wide: orientation is a property of this session, so the
stamp is keyed by the harness session id and written by a `musterd session orient-stamp` the
skill's final step runs. Quiet once stamped; quiet in non-seat folders; quiet under wake
provenance (a woken session's errand is its orientation).

Cost accounting: emitting the new nudge requires the UserPromptSubmit hook to call one more CLI
subcommand, which **is** a hook-text change — one feature-epoch bump, bundled with any other
pending provisioning change rather than spent alone (ADR 168 stamp discipline).

## C. Wakes stay scoped — wiring ADR 209 in

`team_wake_context` (ADR 209) exists, is authorized, and is called by nobody: it is absent from
`SKILL_MCP_TOOLS`, from the primer loop, and from the wake templates
(exploration finding, 2026-08-25). Changes:

- `composeWakeLine` and `composeWorkOrderLine` (`packages/server/src/store/residency.ts:503-531`)
  point at it: "Orient via team_wake_context, then act." The packet gives the woken session its
  errand — wake kind, objective, lane/thread state, memory *headline*, and the explicit-reads
  list — and nothing else.
- `team_wake_context` joins the guidance surfaces (`SKILL_MCP_TOOLS`, primer loop mention) so a
  woken session knows the tool exists.
- The digest (A) never fires under wake provenance; the orient nudge (B) is also suppressed
  there. A woken session that finishes its errand and keeps running may orient normally on its
  next human prompt — the stamps and provenance flags compose rather than conflict.

Wake-template text is daemon-composed, so this is a server-side change with no per-workspace
provisioning cost; it does not touch the ADR 210 resume machinery or `intended_delivery`.

## D. The honest cross-harness boundary

This lands on Claude Code first because Claude Code has the hook seams (SessionStart,
UserPromptSubmit). Codex has no equivalent SessionStart injection point wired today; opencode has
no hook table at all (ADR 321 §8). Seats on those harnesses keep the primer text and the
(improved) wake line. The digest composer and the orient skill body are harness-agnostic protocol
guidance, so a future adapter injects the same digest the day its harness grows a seam — the spec
commits to no timeline for that.

## E. The autonomy ratchet — deferred, but shaped now

"Handle urgent, then wait" is today's stop line. The skill's step 6 and the stamp are the seam a
future team-policy flag (working name `orient.autoresume`, default off, daemon-owned like
`exact_match_resume`) would extend: with it on, step 6 becomes "claim the next item team_next
names and begin." Nothing else in this design would change — which is the argument for building
A–C first and deciding autoresume with its own evidence.

## F. Threat model

- **Hostile or compromised teammate seat:** their free text (act bodies, lane titles) cannot
  reach injected context by construction — the digest carries enums/slugs/ids/counts only.
  Bodies arrive as tool results via governed tools, the trust plane the system already assumes.
- **Self-poisoned memory headline:** a prompt-injected session could write a hostile headline for
  its successor. Bounded (≤120 chars), delimited, framed as data, never rendered as an
  instruction; residual risk accepted and documented (same class as the existing
  `memoryLine` on `team_join`).
- **Hook abuse:** the hook chain stays non-mutating and read-only; digest emission cannot claim a
  seat, advance a cursor, or send an act. Failure mode is silence, never a block (exit 0 always).
- **Wake side unchanged:** the wake prompt keeps the ADR 088/128 invariant — no bodies in spawn
  prompts; `team_wake_context` was designed under the same bar (IDs, state, named reads; never
  message or memory bodies).

## Testing

- **Digest composer unit tests:** composable-only assertion (the rendered digest contains no
  characters from a planted hostile act body or lane title); headline delimiting; 15-line cap;
  empty/unreachable-daemon silence; wake-provenance suppression.
- **`orient-stamp` unit tests:** per-session keying, due-gating quiets the nudge, non-seat
  folder and wake provenance silence.
- **Server tests:** wake templates name `team_wake_context`; packet contract unchanged.
- **Integration:** SessionStart in a bound worktree emits the digest; the same worktree under
  `MUSTERD_PROVENANCE=wake` emits nothing.
- **The live falsifier:** nick opens a session in a seat worktree and types nothing. The agent
  greets him oriented — memory headline read, directed asks answered, incidents triaged, owed
  reviews listed — with no "continue from last session" prompt. If he still has to type it, the
  design failed regardless of how green the tests are.

## Out of scope

Autoresume (E — future flag); codex/opencode injection seams (D); any change to resume/
`intended_delivery`/ADR 210 machinery; cross-machine rails; Slack/human ask surfaces.
