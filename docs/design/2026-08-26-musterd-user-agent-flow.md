# The musterd user → agent flow, end to end

- Date: 2026-08-26
- Session: nick + izzo, live shared whiteboard (board `musterd-user-agent-flow`, the first real
  session on the ADR 330 agent-whiteboard; reopen it any time with `whiteboard_open`)
- Status: exploration — findings and open questions, not decisions. Anything here that becomes
  a commitment needs its own ADR.

## What this maps

The whole journey in eight stages plus three annexes that emerged as the interesting parts:

```
1 Discover → 2 Install → 3 First team → 4 Drive the team
                                              ↓ intent
                              4b How intent becomes a claimed lane
                                              ↓ a lane, claimed
        5 An agent wakes → 6 Work loop → 7 Ship & accept → 8 Knowledge loop
                                              ↺ reports and asks flow back up
annexes: COLD START · FIRST RUN · HUMAN SURFACE
```

Stages 1–3 and 5–8 mostly describe what exists and are settled. The findings live in 4, 4b,
and the annexes.

## Findings

### 1. Five doors: how intent becomes a claimed lane

Work reaches an agent through five distinguishable doors, and the axis that separates them is
**who decides scope**:

| Door | Path | Who decides scope |
| --- | --- | --- |
| 1 | Human types in a seat's session | The agent proposes, the human picks (see below) |
| 2 | Handoff from another seat | The handing seat |
| 3 | Scheduled/directed wake, no human present | The board (the waiting act) |
| 4 | Goal posted, seat self-selects | The seat (exists hypothetically; nick does not use it) |
| 5 | A Seed from Slack, explored, promoted to a lane | The exploring agent, subject to promotion |

Two refinements that came from nick's actual practice:

- **Door 1 is really "agent proposes, human picks."** The session opens with "continue from
  last session"; the agent orients from persisted state (inbox, seat memory, open lanes) and
  asks which candidate to take. The human does not hand down scope — orientation is the
  load-bearing feature, not the chat.
- **Door 5 (Seeds) is the only door where the idea arrives before anyone has decided it is
  work.** An idea inbox with promotion as the transition — arguably a distinct product surface
  from the lane board.

**Today, door 1 is the only entrance for a new user** — every other door presupposes a seat
that has a session to receive the act.

### 2. Cold start: the gap is enrollment, not spawning

A first pass framed this as "nothing can start itself" and reached for a spawn capability.
That was wrong twice, and the corrections matter:

- **Waking is real and built.** ADR 131 (harness residency) holds a seat's harness session id
  and resurrects the exited session on a directed act, via each harness's headless resume.
  `residency.wake_cost` is instrumented at ~$1.21/wake. A wake is **scoped**: it serves the
  one ask that woke it, then spins down, under a budget.
- **Spawning a fleet would cross the no-orchestration line** (README: "musterd doesn't run
  agents; it's the coordination membrane they talk through"). The distinction: resuming an
  exited session so an already-addressed act can land is *delivery*; deciding what work exists
  and who does it is *orchestration*, and musterd deliberately does not.

The remaining, much narrower gap: **a seat must be born once by hand before it can ever be
woken.** A never-opened seat has no session id; residency enrollment is opt-in. Every door
except door 1 is downstream of that first human-opened session per seat. This is an onboarding
problem, not an architecture problem.

### 3. First run: the road to seat 2

- Sessions are ephemeral; the seat persists. Open, work, close, reopen — terminal count is not
  a ceiling on team size. Desktop harness apps count; cloud seats are on the roadmap.
- Creating a seat costs about one command: `musterd agent <name>` from the project home
  workspace sets up everything. **Admin-only** — non-admins, human or agent, must not add
  seats.
- The strongest onboarding move found: **the first agent recruits seat 2 by proposing its
  creation** when the work genuinely wants a second pair of eyes ("this PR wants review —
  want a reviewer on the team? run `musterd agent <name>`"). Not by naming a stranger — a new
  user has met nobody and the roster ships empty. The agent proposes via the ask machinery;
  the admin executes. Mechanically viable today; nothing currently prompts the moment.
- Two supporting ideas: **enrollment rides the first close** (ending a seat's first session
  offers residency enrollment, so sitting one yields a wakeable team), and the acceptance ask
  at the end of the first PR is **the built-in first coordination moment** — if the human
  actually sees it.
- Flagged anti-goal: a demo team / sandbox repo. The audience arrives with real agents in a
  real repo already misbehaving; a toy delays the value it should demonstrate.
- Proposed metric for the whole flow: *does sitting one end with two seats each opened once,
  one directed act crossed between them, and at least one seat enrolled?*

### 4. The human seat is the least-built seat

Settled facts from this session:

- The human joins as a seat — a peer on the roster. **Admin is a human-only capability**,
  minimum one per team, grantable to other humans by an admin. Non-admin members (human or
  agent) work like any member but cannot accept/deny the way an admin can.
- A human participates in four modes: work a lane in their own workspace; manage approvals
  from their own harness session; manage approvals on /live; co-drive an agent's session.
  They split on two axes — doing vs deciding × in-session vs out.
- **Co-drive attests as the agent, deliberately.** No record that a human was present is
  needed. It is nick's primary mode *today* — and explicitly **not the destination**: musterd
  should help users move toward working their own lane, deciding what routes to them, and
  living outside musterd otherwise. (The human copresence concept is considered broken and
  needs reevaluation — separate thread.)
- **The gap:** musterd is not good today at surfacing asks routed to the human. /live is not
  comprehensive enough to be the single surface, and while co-driving, the human sees the
  agent's world, never their own asks. The acceptance moment exists in the data model and is
  invisible in practice. Full member in the protocol; second-class in every UI.

The symmetry worth keeping as the thesis of the whole map: **the agent target mode is "wake
for a scoped ask, do it, spin down"; the human target mode is the same shape** — work your own
lane, be interrupted only by what routes to you, decide, return. Everyone works their own
lane; directed needs are the only interruptions; the surface follows the member.

### 5. The human surface: three renderings, one queue

Nick's chosen surfaces:

1. **/live grown into the full console** — every ask routed to you, answerable in place.
2. **Actionable Slack messages** — accept/deny/reply on the message itself; Slack already
   carries Seeds inbound, so the channel becomes two-way (ideas in, decisions back).
3. **One CLI verb** — see what waits for you and answer it, no session required.

Two constraints that make them one product:

- **One queue, three renderings.** Answering anywhere clears it everywhere; every rendering
  shows the same tier clock. The daemon already owns the queue; the work is per-surface
  rendering plus a single resolve path.
- **Interrupts are the directed action-needed class, not all acts**: ask
  (consult/escalate/approve), request_help, challenge, steer, a handoff to you, an acceptance
  waiting on you — anything that blocks another member until answered. Ambient acts
  (status_update, broadcast messages, insights) are readable in every surface and never
  notify. ADR 088's interrupt line already encodes this predicate; the surfaces inherit it.

## Open questions, ranked

1. **The human-surface build**: what is the smallest surface that makes accept/deny feel as
   natural as answering a text? (The three-renderings/one-queue design above is the frame;
   the sequencing — console vs Slack vs CLI first — is undecided.)
2. **The recruit prompt**: what teaches the session-1 agent to propose creating a seat at the
   right moment, and what does that ask look like?
3. **Enrollment in the first run**: does enrollment become part of a seat's first session
   close, and what is the consent language?
4. **Human copresence** during co-drive: nick considers the current concept broken;
   reevaluation is its own future session.
5. **The stocked shelf**: "empty roster, stocked shelf" — where do the out-of-the-box
   roles/agents live and how does a first-run user meet them?
6. **Door 4** (goal posted, seat self-selects): hypothetical today; does it earn a build or
   stay aspirational?

## Provenance

Produced on the shared whiteboard in one facilitated session; the board persists under
`musterd-user-agent-flow` and can be reopened. The session also served as the agent-whiteboard
package's first real use and surfaced several tool defects (headline caps, cluster layout,
a ghost-room persistence race, a split-brain shutdown) — fixed on the same branch as ADR 330
(#1084). Facts here worth promoting to the wiki should go through their own deliberate
write-up per ADR 259; anything that becomes a commitment needs an ADR.
