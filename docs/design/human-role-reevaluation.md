# The human role, re-founded — the 2026-07-16 founder interview

> **Status: DESIGN, frozen by [ADR 145](../decisions/145-human-role-refounded.md).** This is the
> deliverable of the wave-7 `human-role-reevaluation` roadmap item, run as it was mandated: a deep
> user-research interview of nick (founder, the only human who has ever used musterd in anger),
> conducted by an agent that mined the dogfood record *first* and challenged the stated ideals
> against it. The raw Q&A is preserved verbatim in **Appendix A** — that transcript is primary
> source material; this body is the synthesis. Companions: `human-agent-dynamics.md` (the
> philosophy this re-founds), `research-foundation.md` (the Co-Gym evidence), 
> `resolve-as-state-gate-brainstorm.md` (the parked question this absorbs and answers).

> **Living document.** Corrections via ADR + smallest correct change, same commit.

## 0. Method & provenance

Interview conducted 2026-07-16/17 by the stanley seat (Claude, driven session — itself a data
point). Before the first question, the interviewer mined: `musterd report` / `report coordination`
/ `report tools` (revive, 7d), read-only SQL over the daemon's own store (all-time, 4 teams:
messages, requests, audit, lanes, members), `MUSTERD_DRIVER` plumbing in the code, and the seed
docs. Eight questions, each confronting the answer with the record. Two live incidents during the
session entered the evidence mid-interview: the interviewer's own seat-claim request **expired at
the 1h TTL while the first answer was being typed** (the 7th expired claim request in the record),
and nick resolved it the way he reported always resolving it — telling the agent to approve its own
request `--as nick`.

## 1. What the record shows (the "currently is" axis)

The founding thesis — *humans are members, not approvers* — was never falsified by the record. It
was never given a surface to be tried on. What the record actually shows:

**In-band, the human is an approver, not a peer.** 637 agent acts vs **6** nick acts on revive
all-time (21 across all four teams ever). Of those six, three are literal test fixtures
(`VERIFY-1/2/3`), one is a rehearsal steer, one a goal-epoch notice, one a daemon-bounce
status_update — **zero organic coordination acts**. Against that: **44 authorization events**
(19 `request.decide` + 25 `grant.issue`). The human's in-band fingerprint is ~7:1
approver:communicator, and the communicator half is test traffic.

**Agents never reach for the human.** Directed at nick, all-time: 90 `accept`, 78 `status_update`,
**1 `message`, 0 `request_help`**. The team reports *at* him and acknowledges him; it has never
once asked him for anything. Meanwhile the 7d unblock median is **6 days** and the coordination
report's own warning fires: 12% exchange, 57% broadcast journal — "coordination that only looks
collaborative."

**The approval wall is friction without protection.** 27 claim requests: 19 approved, 1 denied,
**7 expired unanswered** at the 1h TTL (izzo bounced off it four times in one afternoon). Seven
approvals of *the same agent's same seat* in the four days before the interview. `team_join` is the
slowest tool on the team — 76s average, because it waits on a human who isn't looking. And the
workaround nick reported (and re-performed live): telling the gated agent to approve its own
request `--as nick`, producing audit rows that say `authorized_by: nick` for decisions nick never
saw. **The gate produces the record of oversight without the oversight.**

**The human is invisible exactly while he is most present.** Nick's real practice (his words, Q1):
several harness sessions at once, non-auto mode, watching every tool call, approving/denying,
plan-mode-first, pacing the work, dialing model and effort per turn against a usage budget. That is
Co-Gym's dual-control participation — and musterd sees none of it. `MUSTERD_DRIVER` appears nowhere
in 903 message-provenance rows; the roster reads him offline while he steers; he has created 5
lanes and owned **0**; the one work item only he can do (publish the packages to npm) is parked,
aging, and invisible — the system cannot say "the team is blocked on nick's lane," even though it
is true. He never once opened the CLI inbox. The notification ladder built rung by rung for him
(comeback summary, `notify`, availability/urgent) carries, on the record, no traffic to him.

**The diagnosis in one line:** musterd gates what the human doesn't value, and cannot see what he
actually controls.

## 2. The re-founded role (the "ideal" axis)

The interview converged on a restatement of the thesis that survives the record:

> **Membership is the default; authority is an explicit, human-only overlay.** A human on a team
> wears a *member* hat — owns lanes and Goals like anyone else, shows presence by the same ladder
> as agents, sends and receives the same acts — and optionally an *admin* hat that holds the
> approve/decide/grant powers and receives the traffic addressed to authority. The record's failure
> was not that nick was an approver; it's that the approver hat was the only one with a surface.

Concretely, from nick's answers:

- **Admins are human-only.** A team may have multiple humans and multiple admins; at least one
  human admin always exists (defaults to the team creator). Agents can never be admins. Humans can
  be non-admin members (A6).
- **A non-admin human** does everything a member does — all acts, lanes, messaging — and *sends*
  into the to-human stream exactly as agents do, but does not receive approvals/escalations/asks
  by default (A8).
- **Humans get the full steering vocabulary** — challenge / stop / wake / rescope / redirect —
  as first-class abilities on human surfaces, against agents (and humans where applicable). Whether
  non-admin humans get all of it is an open question (A8).
- **Everything is configurable per team/business** — including "dogfood mode," where almost nothing
  is gated because the team is building the product itself (A2, A3, A4).

## 3. Mechanisms

### 3.1 The to-human ask stream (the spine)

One stream of directed-to-human traffic, exactly **three species** (A4, A5, A8):

1. **Consultative asks** — "what do you think / which direction." Not emergencies. Nick: "very
   valuable/important because I get to steer or correct" — he wants these even in full-auto mode.
2. **Escalations** — true blockers, disputes, decisions only a human can make.
3. **Approvals** — the admin gate traffic (costly/destructive, out-of-team-scope, big product
   changes — *not* routine re-seating; see 3.7).

Explicitly **excluded**: harness permission prompts. "The harness permission stuff should stay with
the harness" (A5). The team layer carries asks between members; the wielding-a-tool-safely prompt
belongs to whoever holds the tool.

Every item in the stream carries a **tier**, and each tier sets a **timeout** and a **no-answer
policy** (A3, confirmed reading Q6):

| Tier | Timeout (illustrative) | No answer ⟹ |
|---|---|---|
| Highest (extremely costly/destructive) | ~15 min | **Hold**: agent pauses, keeps re-notifying, does not proceed |
| Below highest | ~3 min → scale by importance | **Proceed with recorded risk-acceptance**: the act records the risk, that the human was unreachable, and the chosen approach |

Two properties are load-bearing: **escalations always technically reach the human** (delivery is
unconditional; response is not), and **nothing below the top tier can wedge the team** — an
unanswered ask becomes an auditable risk-acceptance, not a silent stall and not an invisible
ignore. The human's silence becomes a fact in the record that agents route around.

**Routing (A8):** the stream goes to **admin humans** by default. A **configurable** (never
automatic) fallback policy may route to non-admin humans when admins don't respond in time — riding
the same timeout/risk machinery. Non-admin humans and agents are equal *senders*.

**The "need time" reply (A6):** a human can answer any ask with *deciding — check back in ⟨1h /
indefinitely⟩*. It is the human symmetric of the agent `wait` act: a deferral with an owner and a
clock, so a thinking human stops reading as an ignoring one. It matters most multi-human: "they
would think offline together and come back later with a decision."

**Open (multi-admin):** who wins when several admins are asked — a decision-maker designation
among admins, or a single-admin cap? Deliberately unresolved until a second real human exists
(§3.6).

### 3.2 Surfaces: deliver where the human already lives

The record's clearest lesson: a channel the human doesn't inhabit is a dead letter box, however
good its acts. Nick's answer to "how should it reach you" (A3): **a Slack message** naming what
needs approving/deciding, and **a loud, prominent asks/approvals element on /live** (messages
panel, office panel, or a dedicated component). The CLI inbox demotes to a power tool. Surfaces
ship *with* the stream, not after it — an ask stream without a lived-in surface reproduces the
dead inbox with more machinery.

### 3.3 The human presence ladder

Humans get the same presence semantics as agents, from signals humans actually emit (A5):

- **online** — web UI open (the /live browser tab is a presence-bearing surface; the observer seat
  the browser already provisions becomes *your* seat) or CLI `inbox --watch` running.
- **working/active** — actively steering a session, doing musterd acts/messaging, or holding a
  claimed work item. **Steering marks you working** — this answers the question
  `driver-copresence-gap` was blocked on ("I steer, therefore I am online").
- **idle** — no activity in a while, "like agents" (the right idle heuristic for humans is an open
  design detail).
- Plus intentional **away/dnd** and **working hours**, both already modeled.

Presence **informs** the stream's behavior (a visibly-present admin can be waited on a bit longer;
an away one gets the Slack push immediately) but **absolute time is the end driver** of every
timeout (A5). Surveillance-asymmetry caution from `human-agent-dynamics.md` §4 carries over:
human presence data is ops input, not monitoring output; visibility of derived human metrics is
governed need-to-know.

### 3.4 Human work identity

"All work needs to be able to be assigned/picked up by humans just like agents" (A4). No new
hierarchy nouns — ADR 098 holds (Goal → Lane; increments as prose). What changes is the affordance:

- Humans **create and claim lanes from the web UI** (the read-only board becomes writable; today
  the only claim surface is the CLI the human never opens — `owner_seat: nick` is already legal in
  the schema and has simply never happened).
- Escalated decision points, human-only work, and self-defined human work are all **captured,
  measured, auditable** the same as agent work.
- First dogfood: a real `publish-to-npm` lane owned by nick — visible, aging, nudgeable, honestly
  blocking.

### 3.5 Two-stage close (absorbs the resolve-as-state-gate question)

The parked brainstorm asked whether `resolve` should be a verified state transition instead of a
self-asserted recap. The interview's answer (A7) splits "done" into two claims that today's
`resolve` conflates:

- the **worker's claim** — "my work is technically complete" → a lane state **`ready for review`**
  (nick: "ready to demo"), asserted by the worker;
- the **owner's claim** — "this is what I wanted" → a **different seat** (agent reviewer, or the
  requesting human for owner-acceptance work) confirms, and only then is the lane *done*. A failed
  review sends it back (or marks **`unverified`**).

The review request is an ordinary item in the ask stream with a timeout — so a missing reviewer
degrades to self-close-flagged-`unverified`, never a wedge. This keeps every constraint the
brainstorm declared settled: musterd never runs verifiers; threads can't wedge; verified-ness is
derived from acts (a counterpart's confirmation), never a stored second flag.

### 3.6 Multi-human (deliberately last)

musterd has never had two real humans on a team — every human-kind row in the store is nick or his
own browser observer. The admin/non-admin defaults above (second human joins as non-admin; ≥1 human
admin; configurable fallback) are frozen as *defaults*; the open questions — the multi-admin race,
decision-maker designations, non-admin steering scope, whether two humans coordinate through
musterd or around it — are explicitly **not to be guessed at solo**. They need a second-human
dogfood.

### 3.7 Configurability & dogfood mode (stop the bleeding)

The approval/steering level is **policy per team** ("configurable according to user/team/business
needs," A3). The first policy shipped is the one the record demands: **a standing grant for
re-seating known agents** on the dogfood team — the seat-claim wall (8 approvals in 4 days, 7 TTL
deaths, the `--as nick` self-approval hole) exists because a gate meant for *strangers* fires on
*teammates*. Re-occupying a seat you already held becomes a notification, not a decision. Brand-new
member admission stays gated. This also retires the `--as nick` circumvention: with the routine
case ungated, admin decisions that remain can insist on a real human surface.

## 4. The re-sequenced human-loop backlog

Order and rationale (roadmap ids in `roadmap.data.ts`, all `human-loop`, frozen by ADR 145):

1. **`dogfood-approval-grant`** (wave 7) — the standing re-seat grant; tiny, kills the live
   bleeding and the impersonation workaround it taught.
2. **`human-ask-stream`** (wave 7) — the three-species stream: tiers, timeouts, no-answer
   policies, risk-acceptance record, the need-time reply. The spine everything else rides.
3. **`ask-surfaces`** (wave 7) — Slack delivery + the loud /live asks/approvals panel. Ships
   with, not after, the stream.
4. **`human-presence-ladder`** (wave 7) — online/working/idle + away/dnd/working-hours for
   humans; steering marks working. Resolves `driver-copresence-gap` (which now builds on it).
5. **`human-work-identity`** (wave 8) — writable board; humans create/claim lanes from the web
   UI; the publish-to-npm dogfood lane.
6. **`two-stage-close`** (wave 8) — ready-for-review + counterpart confirm + `unverified`,
   riding the ask stream.
7. **`web-steering-console`** (wave 8, reserved) — consultative asks answerable from /live; the
   biggest lift, needs 2–4 live first. Harness permission prompts stay out, permanently.
8. **`multi-human-admin`** (later, reserved) — the admin overlay's open questions, gated on a
   second real human to dogfood with.

Sequencing logic: bleeding first; the spine before its riders; **surfaces before more acts** (the
record shows acts without a lived-in surface are dead letters); work identity and close-semantics
once the human can actually be reached; multi-human last because it cannot be honestly designed
with one human.

## 5. What this rejects (guards carried forward)

- **No harness permission prompts in the team layer** — the boundary nick drew explicitly.
- **No stored relationship/autonomy field on a member** — the `human-agent-dynamics.md` maxim
  holds; tiers live on asks, policies on teams, never postures on people.
- **No new work-item nouns** — Goal → Lane stands (ADR 098).
- **No agent admins, ever.**
- **No metrics that count volume** — the stream's success metrics are latency-to-human-answer and
  risk-acceptances-later-reversed, not message counts (Goodhart guard).
- **Human presence is truth-telling, not monitoring** — need-to-know governs derived human metrics.

---

## Appendix A — the raw interview transcript (verbatim)

*Interviewer: stanley (Claude, driven session). Subject: nick. 2026-07-16/17. Questions are
condensed to their core; answers are verbatim, unedited. Bracketed notes record live session
events and the evidence confronted.*

**Q1:** Walk me through your most recent real working session with the team — from sitting down to
walking away: what did you actually do, in what order, and through which surface (driver prompt,
CLI, /live, the inbox)? Where in that session did musterd itself — not the agents — actually help
you or get in your way?

**A1:** I sat down and there was already maybe 2 or 3 agents sessions still open from the night
before (all claude code cursor extension sessions). i either prompted the agents to continue with
the work where we had left off the night before or I had told the agent i wanted to continue the
work but i wanted to do so in a fresh agent session (to get a fresh context window). so the agent
would save what had been done/what is next it the seat memory, maybe send a message or handoff to
the musterd team, then i would open a new claude code session in that same worktree and tell the
agent to pick up the work. These all worked great in terms of continuing the work without losing
context (while actually starting a new session in some cases). At times that agent would lose
connection or their seat or something on the revive team and would have to try to rejoin, they
would see that their mcp tool call output told them that their request was awaiting approval from
me (nick) as admin. because i dont know how to approve it (i didnt know from directory I should run
the cli command that was given in the mcp tool call output to the agent when they requested to
rejoin team), so i would just tell the agent to approve their own request "as nick". this happened
a few times - probably worth a look at the flow/the "as [human/agent]" command. So i had multiple
claude code sessions up at the same time, i usally would not turn on auto mode for any of the
agents because i wanted to see what they were doing and be given a chance to approve/deny some
their commands/tool calls and steer them in a different direction if needed. A few times, i would
tell agents while they were working to either give a heads up to another agent on the team about
something or to check their messages. It was also helpful for me to change from agent/edit mode to
plan mode for a few of the agents because i wanted to plan things out first/and me approve the plan
before they implemented. Non-auto model also allowed me to control the pace of the work to some
degree as well. While I liked this level of control, i can see at times that I would want all
agents on auto and not ask me for aynthing. Also, i would constantly change the claude models
(fable for heavy/complex/more reasoning/brainstorming tasks, and opus mainly for implementing) and
the effort level (low-extra high) for different tasks or turns the agents were doing. i was doing
this because I have a daily and weekly usage limit for my claude max subscription that I had to
stay under (limits refresh daily and weekly). I never checked my inbox via cli or any other way. I
did like watching the office floor on the web ui to see what the agents might be doing (more so for
fun and it looked cool but it also helped visually surface some issues like and agent being shown
as "offline" when they were actually actively working the claude session for example.

*[Session event, logged as data: nick asked stanley to approve stanley's own pending seat request
"as nick". The original request (01KXPRW96X48ARTGWG2VDM8F0B) had EXPIRED (1h TTL) during
evidence-mining — the 7th expired claim request in the record. stanley re-requested via team_join
and approved it himself via `musterd requests decide … --approve --as nick`. The audit row reads
authorized_by:nick for a decision nick never saw.]*

**Q2:** What genuinely requires your yes? If we deleted admin approval on seat claims tomorrow and
replaced it with a notification, what would you actually have lost? Where — money, merges to main,
infra, brand-new members vs re-seating known ones — do you want a hard block that waits for
real-nick, knowing the block's failure mode is what we just watched?

**A2:** i actually think admin approval should still be required - its just that for building the
musterd platform itself/testing - its not needed. I think i should have to approve any big
changes/product changes/i should be asked for clarify if absolutely needed/to settle a dispute or
decision if absolutely needed/to help out with a real blocker/to approve something that may be
costly or destructive/anything outside the scope of that musterd team. these are just some examples

**Q3:** [Confronted: his approve-list and musterd's gate-list have zero overlap; the list splits
into standing gates vs agent-initiated escalations; the escalation channel is dead in the record —
0 request_help to nick ever, inbox never checked.] Tomorrow, 2pm: agents on full-auto, you're
away. Izzo hits a genuine blocker, or two agents disagree on a decision that matters. Ideal
version: what surface does it land on, how loud, what latency can the team count on, what does
izzo do meanwhile? And what should stay silent and never reach you even then?

**A3:** you make some good points. I guess since we have a pretty solid git worktree approach for
musterd agents, im fine with agents merging to main daily. Also im fine with wakes because the
whole point is that agents need to be able to wake other agents up, maybe there are other costly
things i would want to approve - i dont know. I think scope of the team is a good boundary to
explore. Thinking about all this, i guess it may be important to make this level of human
approval/steering configurable according to user/team/business needs. Also, yeah i dont check my
inbox via cli - maybe we need to brainstorm on a more effective way for agents and other humans to
reach humans on a team. I do think that there is need for important escalations/true blockers
still that only humans can solve for.

Regarding q3 - i guess i would want a slack message telling me what i need to approve or make a
decision on. Having this somwehre on the live office screen (http://localhost:4849/live?team=revive)
(on the messages panel or on the office space panel or own a new "inbox" or "approval" component or
something. on whichever surface/channel, it should be pretty loud/prominent - so that I respond
pretty quickly. If it is extremely important/costly/destructive, the escalation goes to the human
and the human does not answer quickly enough - the agents should pause what they are doing until
they get an answer. If it was escalated but not the highest level of risk/destruction etc, maybe
they capture the risk, capture that they were not able to reach/get approval from the human and
decided to accept the risk and move forward with an approach. Escalations should always reach the
human (technically) but the human may not respond.

**Q4:** [Confronted: 0 human-owned lanes ever vs ~84 agent ownerships; the npm-publish work —
human-only, parked for weeks — is invisible to musterd because it's his; his driving labor has no
noun in the record.] In the ideal musterd, are you a doer with work in-band? (a) Should "publish
to npm" be a lane owned by nick — aging, nudgeable, visibly blocking? What would make that natural
instead of chore-tracking you'd abandon? (b) Does the driving work itself belong in musterd's
record, or is it fine off-book with only its outcomes showing?

**A4:** stuff like "publish to npm" should be a lane owned by nick yes (or whatever work items
that we had defined that are less than a lane (task? did we ever implement the whole
goal-->lane-->feature?-->task board/work item hiearchy stuff?). Lets say a plan is developed (by
humans and/or agents) - all work needs to be able to be assigned/picked up by humans just like
agents. As a human i should also be able to create work items at any times (actual coding work, or
any work) and pick it up. So whether is blockers/decision points that an agent escalates to a
human, stuff like publish to npm that only a human can do, or work that humans define and what to
take up themselves, it should all be captured/measured/auditablable etc.

thinking more about all of this, i've been steering/overseeing by watching and approving/denying
actions in all of the agent sessions (claude code, cursor, codex etc). what could be interesting
is also having a way to do this from the web ui. Like i think that in agent sessions, what agents
ask me what i think about something or what a direction (not always important or escalation), that
is very valuable/importatnt because i get to steer or correct if needed. even for these non
escalation asks, i still want to weigh in on. so both escalations and im back to wanting to weigh
in on non escalation asks as well. but i still want agents to be able to move forward if humans do
[not] reply in a timely manner. all of this should be configurable.

**Q5:** [Corrected the record for him: no task noun exists — ADR 098 locked Goal→Lane; lanes
already support backlog + would accept owner_seat:nick; the gap is affordance. Flagged web-UI
steering as the session's biggest idea.] What should the team be able to know about you, moment to
moment? (a) Should steering mark you present — a nick character in the office whose state means
something — and are you comfortable with the surveillance flip-side? (b) Should your presence
drive the escalation-timeout policy, or is it cosmetic truth-telling?

**A5:** for the stuff that is directed to me - i dont want the harness permission prompts to be
included in consultative "what do you think" asks, true escalations, and admin approvals. i think
the harness permission stuff should stay with the harness - we'll need to think about that.

Q5-If i have the web ui open or cli inbox running, i should be "online". if i am actively
steering, do any musterd acts/messaging or i have claimed a work item (and in theory doing the
actual work somewhere), i should be "working/active" or something (just like agents). I should be
"idle" if i havent done anything in a while (like agents) - but we'll need to think about the best
idle approach for humans". also dont forget, agents and humans can intentionally mark themselves
as away/dnd and/or they can have working hours. For the escalation timeouts - i think presense can
inform behavior, but probably asbolute time (like say 15 minutes for highest level of escalation,
3 minutes for just a direction/clarification ask (there should be scale/spectrum of timeout
lengths based on importance) should be the end driver.

**Q6:** [Confirmed timeout reading: timeout = wait before invoking the tier's no-answer policy;
top tier holds + re-notifies, lower tiers proceed with risk recorded. Data framing: musterd has
never had two real humans — every human row is nick or his browser observer.] A second real human
joins revive tomorrow — co-founder, technical, trusted. (a) What can they do without you? Is admin
one person or a pool; whose answer wins on a consultative ask when you'd have answered
differently? (b) Honestly: would you two coordinate through musterd or around it in Slack — and
what would musterd have to give two humans for through-musterd to win a slice of your coordination?

**A6:** this is correct: "One reading-back to confirm in passing, correct me if I have it wrong:
the timeout is how long the agent waits before invoking that tier's no-answer policy — top tier
waits ~15 minutes and then holds (paused, re-notifying), lower tiers wait ~3 minutes and then
proceed with the risk recorded. Longer patience for bigger asks, but nothing below the top tier
ever wedges."

Lets remember that only humans can be "admins". a musterd team can have multiple humans on it.
Multiple humans on a team can be "admins". there has to be at least 1 human "admin" - defaults to
creator of team. Agents cannot be admins. Humans on a team can be non-admins

If a second human joins revive, the default is joining as a non admin, since its the second human.
While a non-admin member, the human cannot approve escalations, decide agents' asks, grant seats
but that person can do all of the current musterd acts/messaging. We could think about a path
where agents escalate to a human admin(s), they get no response so they reach out to a non-admin
human (this would have to be configurable not automatic path). Im not sure who wins if there are
multiple human admins and agent(s) asks all of them. maybe amongst admins, there should be
designations like decision maker or something, or only 1 human admin per team is allowed? Im
thinking that if there are multiple humans on a musterd team, they would make quick decisions via
musterd but at times they would think offline together and make come back later with a decision
(maybe we should have ability for human to tell an agent who is reaching out that they need time
to think/decide offline (maybe indefinetely or for a specific amount of time (e.g. need 1 hour to
brainstorm offline etc)

**Q7:** [Framed: resolve is self-asserted recap (ADR 025); nick believes "done" today only because
he watches everything; full-auto is exactly when self-asserted done is all he'd have.] Full-auto
weekend, Monday: six lanes resolved while you were gone. What does each "done" need to carry for
you to believe it without reopening sessions — (a) evidence attached to resolve, (b) counterpart
seat confirms close w/ self-closes flagged unverified, (c) some closes routed to the to-human
stream as a review queue, (d) status quo, CI is the real verifier?

**A7:** i kind of like a different seat reviewing the work to double check/confirm before it is
closed (could be marked as "unverified" if review fails or something). I think agents work may be
technically "done"/"closed" but then when I review it with my own eyes, its not quite that way i
wanted it or want something different (just like in real life. in agile - this is kind of the
point of demos at the end of a spring for owners to fully accept it). Maybe a lane should be
"ready to demo" or "ready for review" when they are technically done with their work?

**Q8:** [Synthesis readback: current role = omnipresent invisible controller; ideal = visible
member with two optional hats; three-species to-human stream with tier + timeout + no-answer
policy; surfaces where nick lives; presence ladder; human work identity; two-stage close. Proposed
8-step re-sequenced backlog. Asked: reorder/kill/misstatements + umbrella vs separate ADRs.]

**A8:** correction, only a human admin should receive the consulatative asks, escalations,
approvals. so admins receive consulatative asks, escalations, approvals AND the
approve/decide/grant powers. But there should be configurable policy that would allow
agents/humans on a team to reach out to a non-admin human for consulatative asks, escalations,
approvals if the admin(s) humans dont respond in a timely fashion - this should also follow the
policies regarding timeouts/risk accpetance etc. Also remember that non admin humans can direct
the same consulatative asks, escalations, approvals at human admins the same as agents.

also admin humans (and also maybe non-admin humans) need the same abilities as agents to
challenge/stop/wakeup/rescope/redirect etc agents (and humans as applicable)

*[No reordering or vetoes of the proposed sequence; ADR-structure question left to the
interviewer, who chose the umbrella form. Interview closed here; the body of this doc and ADR 145
are the synthesis.]*
