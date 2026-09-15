# The human surface: a queue nobody answers, the /live bar, steer & stop, and the second human

**Status:** design exploration — decisions recorded from a live whiteboard session, not yet ADRs
**Date:** 2026-09-01 (evening session; written up 2026-09-02)
**Participants:** nick (human admin), izzo (facilitating seat)
**Source:** whiteboard `musterd-user-agent-flow` (clusters: THE QUEUE MEASURED, SUFFICIENCY,
STEER & STOP, MULTI-HUMAN, HUMANS NO AGENTS, THE SECOND-HUMAN DOGFOOD, POSTURE ADAPTERS),
building on `docs/design/2026-09-01-codrive-graduation.md` (#1141) and
`docs/design/2026-08-26-musterd-user-agent-flow.md`.

## Why this session happened

The co-drive graduation session left three decided-but-unpinned threads and four open ones.
Every decided thread terminates in the same place: a queue of human decisions — the tier-2
pick becomes an ask, the recruit proposal becomes a one-tap approval, acceptance waits on a
human. The HUMAN SURFACE cluster that renders that queue had five thin notes and had not been
touched since 08-26. Nick chose to go at it. The session then followed the thread into who
may steer and stop agents, whether multiple humans on a team is a real product, and what a
second human on a second laptop actually requires — and closed on the posture-adapter thread,
where the code contradicted the previous session's design.

## 1. The queue, measured — it is write-only today

Before designing a surface, izzo measured the queue it would render (query against
`~/.musterd/musterd.db`, 2026-09-01; falsifier: re-run the join — if human answers land some
other way, they are not in the messages table).

| Measure | Value |
| --- | --- |
| Asks routed to a human seat since 2026-07-20 | 57 |
| Of those with a human reply in the record | 4 (all tier `standard`; mean 98.5 min) |
| Blocking asks answered | 0 of 12 |
| Advisory asks answered | 0 of 13 |
| Asks carrying `thread_id` | 0 of 57 |
| `ask.raised` audit rows vs recorded dispositions | 437 vs 8 (4 risk_accepted, 3 held, 1 deferred) |
| Nick's last act of any kind through musterd | 2026-08-22 |

Three readings fell out:

- **The clock is the decider, not the human.** Everything not in the 8 dispositions resolved
  by the tier contract timing out and the agent proceeding with risk logged. The timeout was
  designed as a safety valve; in practice it is the primary decision mechanism. Consent is
  manufactured by a clock.
- **There is no reply channel.** Every ask to a human was sent with a null thread, so even a
  willing human has nothing to answer *into*. `reply_to` exists in the protocol and is unused.
  This is a missing affordance, not neglect.
- **Decisions do happen — in the transcript, not the record.** PRs merge with
  `authorized_by: nick`, lanes get routed, priorities change, all by voice in co-drive
  sessions. The queue is not a backlog of unmade decisions; it is a parallel ledger running
  empty beside the real one. The diagnosis is not "nick is behind on his queue" but **"the
  queue is not where nick lives."**

Open question carried forward: is the human surface's *first* job to render what is pending,
or to **capture the in-session decision into the record** ("merge 1156" said in a transcript
could have discharged an ask)? A surface that only shows pending items is a second place to
visit and will lose to the terminal the human is already in.

## 2. Sufficiency — /live good enough to be the only place

Nick's answer to "where would you have wanted big-body's blocking ask?": he saw it in
big-body's own agent session, and *"if the /live UI was capable enough for me to only monitor
that, I would like to act on it there. Also Slack."*

- **Principle: deliver where the human already is.** Every delivery that has ever worked
  landed in a transcript the human was already watching. Slack is already such a place, so it
  earns delivery without clearing any bar. /live is not such a place yet — and "capable enough
  to only monitor that" is precisely the condition for it to become one.
- **The requirement is a bar, not a backlog.** A half-built /live earns zero adoption, because
  half means the terminal still gets opened. Slack is cheap; /live must clear a high bar
  before it earns a single answered ask.
- **The crux of the session:** "capable enough to only monitor" points at a *stream* (what
  every seat is doing, live), which drifts toward rebuilding a terminal in a browser. The
  graduation thesis says routine watching should *disappear* (posture policy removes the
  permission prompts, self-selection removes the tier-2 dispatch), leaving discrete decisions
  — a *queue*. Both readings build different products.
- **The thing musterd cannot see:** what actually anchors a human to a transcript is answering
  the harness's own permission prompts, which are Claude Code / Cursor UI events. Either the
  stakes→posture policy really eliminates them, or the harness must relay each prompt into
  musterd as an ask and accept an answer back — a far larger integration than rendering a
  queue. (STAKES → SUFFICIENCY link on the board.)

**DECIDED (nick): the queue reading wins, with one addition.** Pending asks answerable inline
+ every seat's current status + the PR/diff at acceptance + a red incident signal is enough
to stop opening the terminal — *"if those were available on /live, I wouldn't need to go to
terminal."* No live transcript. **Plus the human must be able to steer and stop agents from
/live.** So /live is a decision queue *and* a control surface, and explicitly not a
transcript viewer.

## 3. Steer & stop — the control half of /live

### Steer is built; only the trigger is missing

ADRs 088/103/111/125 shipped the interrupt line: `GET /inbox/interrupt-check` runs at every
tool boundary via the PostToolUse hook, daemon-composed so injected text is never raw
teammate prose. Audit held 107 `interrupt.raised` rows, the most recent minutes before the
measurement. A steer raised from /live would reach a busy agent in seconds today.

This is the second session in a row with the same shape (last time: the wake actuator was
fully built and only the button was missing). Promoted to the thesis of the effort:
**musterd's mechanisms are ahead of its surfaces — /live is a rendering-and-trigger project,
not a systems project.**

### Stop is three verbs wearing one word

1. **Halt this turn** — the Esc key. Needs a live channel into the harness process; the only
   genuinely unbuilt piece.
2. **End the session** — the exact inverse of the wake actuator, which musterd already owns.
3. **Stand down from this lane** — release the claim; pure coordination, expressible today as
   `steer` + `lane_release`.

Nick was picturing (1).

### Does halt cross the no-orchestration line?

**No — by musterd's own definition.** The line is: resuming a session so an addressed act can
land is *delivery*; deciding what work exists and who does it is *orchestration*. Halting one
turn decides neither. Three sharpeners:

- **The process-touching line was already crossed in the more dangerous direction.** The wake
  actuator *starts* harness processes. A layer that can spawn but not reap is not more
  restrained, just asymmetric the wrong way.
- **The real line is agent-halts-agent, not human-halts-agent.** An agent that can preempt its
  peers mid-work is the hub-and-spoke failure the interrupt-line doc diagnoses. **Halt is
  human-only** — that is the constraint an ADR should carry, not a prohibition on halting.
- **Stop as revocation, not control.** ADR 337/347 session leases already die on supersession
  or release; the ADR 150 PreToolUse gate already fronts every tool call. Revoke the lease and
  flip the gate to refuse-with-reason, and the agent can neither act on musterd nor use a
  tool. No process is controlled; a permission is withdrawn.

**DECIDED (nick): halt is in, human-only, and decomposes into two builds.**
Revoke-the-lease (boundary latency, mostly built, coordination-shaped) ships with the queue.
Esc-into-the-harness (a live channel into the running process — a new security surface, since
whatever can halt a session can generally also speak into it; note the channel already exists
one way via `musterd-nudge-relay`) deserves its own argument.

**Honest limit, in red:** both gate and revocation act only at tool boundaries.
Mid-generation is unreachable, and a ten-minute build is one tool call with no boundary
inside it. Gate-stop is best-effort with a bounded window — fine for "stand down," not an
emergency brake.

## 4. Multi-human — never dogfooded, deliberately unanswered

Nick's question: should every human be able to press these buttons, or only admins? Maybe a
non-admin may only act on a seat they started? And could musterd carry a team of humans with
*no* agents?

### Prior art

`docs/design/human-role-reevaluation.md` §3.6 already asked this and refused to answer it
solo: musterd has never had two real humans on a team. Frozen there as defaults (nick's A6): a
second human joins **non-admin**; cannot approve escalations, decide agents' asks, or grant
seats; can send every act. Exactly one thing was flagged open — whether non-admins get the
steering vocabulary (challenge / stop / wake / rescope / redirect). That is tonight's halt
question.

### The authority argument

- **Nick's idea — authority follows the wake:** a non-admin may steer/halt only a session they
  started. Elegant (no ACL; the wake and halt buttons become one capability; matches the
  seat-2 steward flow).
- **Its failure mode inverts safety:** an agent-triggered scoped wake has no human starter,
  and a session an admin started cannot be halted by the non-admin watching it go wrong right
  now. The person *present* is the one who cannot act.
- **DECIDED (nick): admins can promote other humans to admin.** At least one human admin
  always exists (defaults to the team creator); agents can never be admins. So "admin-only" is
  a default with a one-tap exit, and trust accrues by promotion, like the co-drive graduation.
- **But promotion is all-or-nothing:** letting a teammate halt a runaway agent by making them
  an admin also hands them escalation approval, ask decisions, and seat grants — over-granting
  for a purely operational need ("I'm watching this go wrong and you're asleep"). That is the
  real case for a steering scope separable from the admin hat.
- **In-character resolution:** musterd is advisory with hard attribution (lane contention
  "advisory — never blocked"; stakes declared, not enforced; the interrupt line warns rather
  than preempts). The consistent move is **any human may halt, every halt is signed and
  visible to the halted seat and the team.** Abuse becomes visible rather than prevented.
  Left as izzo's recommendation, not decided — see §5 for why the answer can wait.

### Humans with no agents: no

Izzo's read, stated rather than explored politely:

- **The tier contract only means something to a machine.** 15-minute HOLD, 5-minute
  proceed-with-risk-recorded exist so a program can decide how long to wait before acting
  alone. No human proceeds-with-risk after five minutes; they wait or DM. Strip the agents and
  the spine of the act system loses its reason to exist.
- **Tonight's measurement is evidence against it.** Human-to-human, musterd is used 4 of 57
  times with the tool right there. On the only team that exists, human coordination already
  routes around it.
- **The real axis is who cannot read the room.** Humans have language, context, and Slack;
  agents need explicit protocol because they infer none of it. musterd is better understood as
  an **agent-legibility layer that admits humans** than as a team tool that admits agents. At
  zero agents it is ceremony competing with Slack, Linear, and GitHub on their turf.
- **Two things genuinely survive:** lane contention over file surfaces (no human tool computes
  it; tonight's handoff auto-surfaced six overlaps, one real; the multi-agent-tax doc measured
  37% wasted work from that shape) and the attestation spine (a compliance product with a
  different buyer — chasing it blurs the agent-chaos hook).
- **Sleeper: multi-human matters *because* of agents.** ADR 056/101 want work judged by a
  different model than produced it; the 08-26 board decided acceptance can land on a human
  when no agent qualifies; and tonight's picker measurement found 10 `no_candidate` rows with
  eligible reviewers excluded (the lane handed to ryder, later #1160). Every additional human
  is another valid cross-family acceptor and a pressure valve on a routing ladder that
  provably jams. That payoff only exists on a team *with* agents.

## 5. The second-human dogfood — second laptop = second node

Nick can get a second human, on a different laptop on the same network. The laptop matters
more than the human.

- **Do not let them run their own daemon.** `deployment-topology.md` "Not yet true": pushed
  events land in `sync_log` and stop — nothing applies remotely, lane claims stay local until
  3c (open, unowned). A second human on their own daemon would not see the team, and the
  experiment would fail for a reason unrelated to humans. If they did federate, stanley's
  3b-ii finding (folded remote events invisible to ts-keyed cursors — since landed as ADR 349,
  #1161) sits directly in that path and would read as "musterd dropped my messages."
- **Run it on one daemon** — topology A: nick's daemon is the single authority, the second
  laptop connects over the LAN. Transport is built (ADR 040: off-loopback-requires-TLS guard,
  `wss://`, Origin/Host checks). Three prerequisites: (1) bind off-loopback, which the ADR 040
  guard forces TLS for; (2) a human credential — `membership-model.md` names it; the agent-side
  equivalents (`msac_`, ADR 337; scoped bootstrap creds, ADR 344) landed tonight; (3) an audit
  of `http.ts`'s `isLocalPeer` trust, written when "local" meant "the only machine" — each
  such route silently refuses the second human.
- **The cheapest real dogfood is the good one: they open /live in a browser.** No CLI, no
  seat worktree. They get presence and the roster immediately, and once the queue and control
  surfaces exist, asks to answer and agents to steer. **The dogfood and the build are the same
  piece of work** — the second human is the first real test of the surface this session
  designed.
- **Uncouple the experiments.** Multi-human *policy* (who may halt, non-admin scope,
  multi-admin race, through-or-around) needs two humans on **one** daemon. Multi-node
  *federation* needs 3b-ii and 3c. They were coupled because "second human" sounded like
  "second machine." Uncoupled, the §3.6 answers are reachable now — which is why the
  halt-authority decision in §4 can wait for evidence instead of being guessed.

## 6. Posture adapters — harnesses do not share a leash vocabulary

The open thread from the graduation doc, grounded in the adapter code. The code contradicts
the previous session.

- **Four wake backends, and Cursor is not one.** `packages/cli/src/host/backends` holds
  claudeCode, codex, opencode, native. Cursor exists only as an onboard adapter that writes
  config — a Cursor seat can be provisioned but never woken.
- **The posture seam already exists.** `WakeArgOpts { toolPolicy, maxTurns }` is delivered on
  the wake order by the daemon's effective policy, one posture per run. It expresses tool
  scope, not permission mode.
- **COLLISION: ADR 131 §6 forbids the wake from ever loosening the leash.** Every backend
  hard-codes the tight end on purpose, with argv tests guarding it ("NEITHER policy ever
  passes a skip-permissions flag"; codex "never carries a trust, sandbox, or approval
  bypass"; opencode keeps the default posture deliberately). The graduation decision "the wake
  is where posture gets set, including low-stakes auto" requires deliberately breaking a
  locked invariant, and nothing had surfaced it.
- **The threads assume opposite supervision — attendance is the missing axis.** §6 is strict
  because a wake is *unattended*. Nick's auto-mode intuition came from *co-drive*, sitting
  there watching miley do UI. Both are right about their own case. The honest model is
  **posture = f(stakes, attendance)**: the same low-stakes lane deserves a different leash at
  3am than at the desk.
- **The vocabularies are not isomorphic.** Claude Code's permission modes govern what it
  *asks about*; Codex pairs approval with an OS-level *sandbox* governing what the process can
  *touch*. One musterd word mapped onto both means "low" buys prompt-suppression on one and
  real containment on the other. And nick's own axis — "auto is fine wherever side effects
  cannot escape the PR chain" — is a *containment* claim that a workspace-write sandbox
  literally implements, while Claude Code's auto mode contains nothing. **The harness with the
  weaker prompt story has the stronger safety story, and the one nick uses daily has the
  weaker one.** (Codex flag names came from izzo's own knowledge, not the code — verify before
  building.)
- **Posture as a guarantee, plus a capability matrix.** Define posture as what musterd
  promises ("no side effect escapes the PR chain", "no network egress", "no spend"), never as a
  harness flag; each adapter declares which guarantees it can enforce, the same shape as the
  doctor's baked-env inspection.

**DECIDED (nick): when a harness cannot enforce the posture policy asks for, downgrade to the
tightest posture it can honour and record the gap.** Not refuse, not ask — in character with
advisory contention and declared stakes: make the gap visible rather than prevent the work.

**With a floor (izzo's amendment, not contested):** downgrade assumes there is always some
tightest-posture to land on. A harness that can enforce *nothing* would run with zero
guarantee while the record claims a posture was applied — false assurance, the same failure
shape as the decorative hook in #1146. So: **a harness that can enforce no guarantee cannot
take a lane that requires one.** Below the floor, refuse or route to a seat that can.

### Cursor walks straight into the floor

Cursor does not have a vocabulary problem; it has a **no-enforcement-surface** problem.
`cursor.ts` registers five hooks — sessionStart, postToolUse, afterShellExecution,
afterMCPExecution, sessionEnd — all observational, for attestation and session capture.
Claude Code gets PreToolUse (the ADR 150 lane gate) and PostToolUse (the ADR 088 interrupt
line). Cursor gets neither. Consequences:

- **A Cursor seat is not lane-gated.** Out-of-scope writes are not blocked, so the derived-
  stakes argument ("scope is verifiable because the gate catches the first out-of-scope
  write") does not hold there.
- **Stop-as-gate has nothing to hook into** on the harness nick was actually reading when
  big-body's ask arrived.

Nick asked whether "observe-only" means Cursor seats cannot write. **No — the opposite.**
Observe-only describes musterd's *instrumentation*, not the agent. A Cursor seat writes
whatever it wants; musterd can watch and attribute but not refuse. **The seat musterd can
guarantee least about is the one running with the most freedom, and nothing on the board or
in the code says so.** The floor rule reads: not "a Cursor seat can't write" but "musterd
cannot promise where a Cursor seat's writes land, so a lane whose posture depends on an
enforced guarantee should not route there." Most lanes are unaffected, since normal posture
promises no containment anyway.

Recommendation, in order:

1. **Declare Cursor observe-only in the capability matrix, explicitly.** Honest, makes the
   floor enforceable, costs nothing.
2. **Re-measure Cursor's pre-execution hooks.** The documented surface includes
   `beforeShellExecution` / `beforeMCPExecution` / `beforeReadFile`; a pre-event that can
   *deny* is the single prerequisite for a lane gate, stop-as-gate, and any real posture.
   ADR 265's measurement is from 2026-01-23 against an event surface that was already a moving
   subset.
3. **Then the mechanism: for harnesses whose leash lives in config, the wake writes the
   config before launching.** musterd already writes `.cursor/mcp.json` and
   `.cursor/hooks.json`; per-seat is free (every seat has its own worktree), per-lane works
   (the wake happens after the lane is known). Argv for harnesses with flags, config-write for
   harnesses without.

The catch on (3), which is why (2) comes first: `.cursor/` lives inside the seat's own
worktree, so the agent can edit its own leash. On Claude Code a PreToolUse gate could refuse
writes to the policy file; on Cursor there is no gate, so file-based posture is self-defeating
exactly where it is most needed. Same circularity as agent-declared stakes, same resolution:
**the constraint must live where the constrained party cannot reach it.**

### Postscript: the "missed Cursor session" was not a capture failure

Izzo had described big-body as a Cursor seat, from nick's "big body cursor agent session."
Its binding records claude-code, and the session flagged a bigger possible finding: if nick
was in Cursor on that worktree and no session was captured, that would be the ADR 265 subset
problem live. Checked the next morning (2026-09-02): zero `surface:cursor` claims from any
seat in 24 hours, and **Cursor was never wired into big-body's worktree** — no
`.cursor/hooks.json` or `mcp.json`, only codex fragments. Nothing was missed; there was
nothing to capture with. Cursor has since been wired there (`musterd harness configure
--select codex,cursor`). Whether the *next* Cursor session on big-body is captured is the
measurable test of ADR 265 that this session wanted.

## Decisions recorded (nick, on the board)

- **/live is the acting surface, if it can be the only thing monitored** — asks inline, seat
  status, PR/diff at acceptance, incident signal; no transcript. Slack as a delivery surface
  too.
- **The bar includes control:** steer and stop from /live.
- **Halt this turn is in, and human-only.** Two builds: revoke-the-lease now, Esc-into-the-
  harness later with its own argument.
- **Admins may promote other humans to admin.** At least one human admin always; agents never.
- **Downgrade-and-record** when a harness cannot enforce the requested posture; with the floor
  rule as izzo's uncontested amendment.
- **Second-human dogfood is reachable** — second laptop, same network; run it on one daemon.

## Open questions

- Is the human surface's first job rendering pending asks, or capturing in-session decisions
  into the record? (§1)
- Who may halt: any human with attribution (izzo's recommendation), admin-only, or a separable
  steering capability? Deferred to the dogfood by design. (§4, §5)
- Can the stakes→posture policy actually eliminate harness permission prompts, or must the
  harness relay prompts into musterd as asks? Decides whether /live is a queue or a control
  plane. (§2)
- Cursor's current pre-execution hook surface — re-measure before designing posture on it. (§6)
- The ADR 131 §6 collision needs its own ADR: an attended-session posture that §6's
  unattended-wake invariant does not govern. (§6)
- Whether the capture of the next Cursor session on big-body succeeds. (§6 postscript)

## What this is not

Not ADRs. Candidates, in the order other pieces lean on them: (1) stop as revocation and the
human-only halt constraint; (2) posture as a guarantee with the downgrade-and-record floor and
the attendance axis, reconciling ADR 131 §6; (3) the /live sufficiency inventory as the
acceptance test for the human-surface build. The second-human dogfood is a lane, not an ADR:
off-loopback bind, human credential, `isLocalPeer` audit, and a browser.
