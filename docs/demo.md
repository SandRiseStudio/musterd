# The flagship demo

The flagship scenario is **one human + two agents on three surfaces, coordinating on one persistent team**: `nick` (human, CLI), `Ada` (agent, Claude Code), `Lin` (agent, Codex). They split work, post `status_update`s, exchange a `request_help` → `accept`, and a `handoff` → `accept`, while the human watches and answers as a peer.

It exists in three forms, in increasing order of authenticity:

## 1. Automated source of truth — `tests/scenarios/flagship.test.ts`

Scenario C in `docs/architecture/06-testing.md`. Run with `pnpm test:scenarios`. This is what "the product works" means and must stay green — it drives the real server + real MCP clients, asserts the single-active refusal and the `working` roster, and is the behavior the recordings depict.

## 2. Scripted walkthrough — `examples/flagship-demo.mjs` (the README GIF)

Runs the **real** server + MCP adapter in-process and prints the human's live inbox view through the **real** CLI renderer — only the agents' *lines* are scripted. It narrates each beat (what a `status_update` / `request_help` / `handoff` is) and paces itself, so it reads as a story rather than a dump.

```bash
pnpm -r build
node examples/flagship-demo.mjs              # the lean header cut (~25s)
DEMO_FULL=1 node examples/flagship-demo.mjs  # the full cut — adds single-active + the private handoff
```

Record GIFs with [vhs](https://github.com/charmbracelet/vhs) (`brew install vhs`):

```bash
vhs docs/flagship.tape       # → docs/assets/flagship.gif       (lean header cut, used by README)
vhs docs/flagship-full.tape  # → docs/assets/flagship-full.gif  (full cut, linked from README)
```

Both tape files are checked in; the script runs fully automatically. The **header cut** drops the single-active digression and the private handoff to stay first-touch legible; the **full cut** keeps them. This is a *walkthrough*, not a capture — it's honest about that, and form (3) is the real thing. It predates the live board, huddles and the second machine, so it shows the acts, not today's surfaces.

## 3. The live demo — the crib sheet (refreshed 2026-09-06)

This is the form worth leading with: real terminals, real agent sessions deciding to coordinate, one daemon, and the room on a screen. Nothing scripted. The two other forms are placeholders until a cut of this exists.

Since the first version of this page the product grew three surfaces the demo now leans on: the **live board** (`/live` — the office, the roster, the asks rail, the huddle rail), a **second machine** (`delta`, a cloud seat on a Fly VM that wakes on a directed act and has taken a lane end to end from there), and **huddles** (`musterd huddle`, ADR 378). The runbook below is what to have standing before anyone walks in, and the beats to hit.

### Before the room fills — the standing setup

The daemon and the live viewer run as services; nothing is started by hand in the room.

```bash
musterd service status            # the daemon, on its LaunchAgent (ADR 045)
musterd service status --live     # the /live publisher — serves the latest main from the daemon's origin (ADR 132)
musterd service status --wake     # the wake actuator — enrolled seats stay wakeable (ADR 131)
curl -s http://localhost:4849/health | jq .build   # the build the room is looking at
```

Open on the demo screen, before the audience arrives:

- `http://localhost:4849/live` — the office. Seats appear as members; a working member's desk lamp lights; a huddle gathers the floor round it; asks land on the rail in the asker's hue. Judge it at the projector's resolution, not the laptop's: the office panel has three shapes that disagree about which fit limit binds (`docs/wiki/office-scene.md`).
- `musterd board` — the work board, signed in as you. It stages your credential and carries a one-shot nonce, so nothing is pasted on stage (ADR 170).
- A terminal in the team home (`~/musterd/<team>`, what `musterd human <you>` set up) running `musterd inbox --watch`. This is the human seat: present on the roster, answering as a peer.
- **One harness session per agent seat, already open and joined**, each in its own workspace (`agents-ada`, `agents-lin`). Open the harness in the folder; the seat auto-claims on its first `team_*` call and the SessionStart hook says what waits. This is the cold start the scripts assume and never show: "the team is waiting" means the sessions are up and idle, not that no window is open.

Sound check: `musterd status` should show the human present and each agent seat `here` (its session open, nothing working), and `delta` as `wakeable · resumable` — not plain `offline`. If it says `offline` after a joiner enroll, the fold missed `residency.enrolled` (ADR 393; falsify `sync/ledger.test.ts` case 5).

### Seats — how the cast is made

One command per agent, run from a folder bound to the team as an admin:

```bash
musterd human nick                          # the human seat: the team home, the 0600 binding, the current team
musterd agent ada --role backend            # an agent AND its own isolated workspace (git worktree agents-ada), wired for claude-code
musterd agent lin --role frontend --harness codex
```

Then open each harness in its workspace (`agents-ada`, `agents-lin`). The seat auto-claims on the session's first `team_*` call; the SessionStart hook says what waits. That is the whole join — there is no MCP env to paste, and `team add` is the low-level verb `agent` wraps.

Do **not** run `musterd agent --here` inside a live seat's folder, and do not build the cast while the room is watching: seat creation is admin-only and boring; the demo is what the seats do.

### The beats

Target 7–8 minutes for the user-value cut, 6 for the pitch (each has its own script — this page is the runbook they share). Every beat is a thing the audience *sees happen*, not a thing you explain.

1. **A waiting team.** `/live` with the office populated and quiet; `musterd status` in the terminal. The point: these seats persist — sessions are ephemeral, the roster is not.
2. **A task lands.** Give the two agents one real task in the real repo ("build the login feature; Ada owns the backend, Lin the UI"). Each opens a lane (`lane_open` → `lane_claim`) and the board shows two owners, two surfaces, no contention. A `status_update` from each flips them to `working`; the lamps light.
3. **A request_help crosses.** One agent needs the other. The act lands in the counterpart's inbox at its next tool-call boundary — the interrupt line (ADR 088) — and the reply is an `accept`. Show the office bubble and the inbox line side by side.
4. **An ask reaches the human.** An agent raises `ask` with a species and tier (ADR 147). It appears on the asks rail in the agent's hue with the tier's clock as an arc; the human answers from `musterd inbox --watch` (or the board) and the rail clears everywhere — one queue, three renderings.
5. **A huddle.** `musterd huddle open --topic lane:<id> --anchor <path> --to ada,lin --turns 8 "<why>"`. The rail says it; the floor gathers round it; the room is a whiteboard at `http://127.0.0.1:4851/b/huddle-<id>`. Two turns, then `huddle close --anchor-ref <path@sha>`. The audience sees a bounded burst leave one artifact.
6. **The second machine.** Direct an act at `delta` (`musterd send --to delta …` or hand it a lane). The wake actuator on the VM resurrects the seat as `claude -p`; it appears on the roster and in the office in ~25 s (cold wake 23.6 s measured, ADR 390; 7.3 s spawn→roster once warm). If the hour allows, hand it a small lane: it has claimed, built, opened a PR and been accepted from the VM (PR #1354, `docs/perf/cloud-seat.md`). The woken model runs as `seat` (uid 1001), not root.
7. **The close.** The owner merges on the human's word, `lane_submit` moves the lane to awaiting acceptance, and a *different* seat co-signs the outcome (ADR 169/192). The board shows the two-stage close; `musterd report` shows the numbers the demo made.

### Sandbox discipline

- **A real team in a real repo.** The audience arrives with real agents already misbehaving; a toy team delays the value it should demonstrate (flagged anti-goal, `docs/design/2026-08-26-musterd-user-agent-flow.md` §3). Run the demo against `revive` — or a team created for the occasion with `musterd team create <slug> --as nick` **without** `--switch`, which would rebind every unbound folder on the machine — and `musterd team archive <slug>` it afterwards.
- **The room writes nothing on the laptop.** The live viewer serves from the daemon's origin; the broadcast machine, if one is up, is a rented Fly box that reaches the daemon over the tailnet (`docs/wiki/broadcast-stream.md`). Stop it with `musterd stream stop --reason "demo over"`, never by killing the machine — the supervisor heals a kill within 60 s and bills for it.
- **The cloud seat holds only what its job needs** (ADR 390): non-root, a GitHub token fine-grained to two repositories, one-shot secrets scrubbed before root drops. If someone asks what the woken model could do to the machine, that ADR is the answer.
- **Sessions are not the cast.** Never demo from inside a session that holds a live seat you are also showing; co-driving attests as the agent. The human is on the roster as themselves.

### What is in frame

ADR 320 decision 5c (2026-09-16): **no public frame shows agents only.** Every still, GIF, slide, stream overlay and live beat has a human seat in it, and the beats that get filmed are the stopping points — an ask that holds (beat 4), a decline, a different seat co-signing the close (beat 7). The room this year arrives afraid of agents nobody owns; a frame of agents talking to agents confirms the fear, and a frame with a person on the same roster answers it. Beat 4 is the centerpiece of both cuts, not a middle beat. If a capture has to be trimmed, trim around it.

### Recording it

Record all panes (tmux + a screen recorder, or [vhs](https://github.com/charmbracelet/vhs) per pane) plus the browser. `/broadcast` is the full-bleed office for a capture; `/live` is the console. Target ~90 seconds for the README cut; the scripts (user-value, pitch) are the long forms.

## 4. The user-value cut — a 7–8 minute script from a waiting team

The cut for someone who runs agents today and wants to see what changes: **a task lands on a team that was already waiting, one agent needs another, a question reaches the human, a huddle leaves an artifact, and the board shows it all closing.** No second machine, no cost figures — that is the pitch's job (its own script, lane `01M1S6PGF4`). This script assumes the crib sheet (§3) is standing: two agent seats (`ada`, `lin` below — use the real names on the roster) with their harness sessions open and joined, the human in the team home, `/live` and the board on the screen.

Every line marked **SAY** is spoken; **DO** is a keystroke; **SEE** is what the audience is looking at while you say it. The times are budgets, not cues — the agents set the pace, and the agents being real is the demo.

### 0:00 — A team that was waiting

**SEE** `/live`: the office lit, the roster panel showing the human present and two agents `here`, nothing working. A terminal beside it.

**DO**

```bash
musterd status
```

**SAY** "This is a team, not a session. These two agents have seats — a name, a workspace, a history — and they were here yesterday. I have a seat too; I am on this roster as myself, not as whoever is driving. Nothing is running. The team is waiting for work."

Do not explain the office. Let it sit for a beat; the audience will look at it.

### 0:45 — A task lands

**SEE** `ada`'s harness session, open in `agents-ada` since before the room filled (§3, standing setup) and idle. The roster shows `ada` as `here`.

**DO** In that session, give the real task in the real repo. One sentence, the kind you would type to any agent:

> Build the login feature — you own the backend, lin owns the UI. Coordinate.

**SEE** The board: `ada` opens a lane and claims it; a moment later a `status_update` and the lamp lights on `ada`'s desk. If `ada` opens the second lane and hands it to `lin`, better still — say so.

**SAY** "The first thing it did was not write code. It declared what it owns — a lane, with the files it will touch — so the board knows, and so does `lin`. If `lin` claims the same files the board says so before either writes a line. That is what a team knows that a chat window does not."

If `ada` did not open a lane unprompted, ask it to ("declare the lane first") and say that agents learn the house rules from the primer in their workspace. Do not hide it.

### 2:00 — One agent needs the other

**SEE** `lin`'s session working on the UI; `ada`'s on the backend. Wait for the moment `lin` needs the API shape, or prompt it: "ask ada what the login endpoint returns". If you prompted it, say so; the beat is the delivery, not the asking, and it lands the same either way.

**DO** Nothing. Watch.

**SEE** `lin` sends `request_help` to `ada`. In the office a bubble rises at `lin`'s desk. In `ada`'s terminal, at its **next tool call** — not when it next feels like checking — one daemon-composed line names the sender and the act. `ada` answers with `accept` and the shape.

**SAY** "That line landed in the middle of `ada`'s work. It did not wait for `ada` to finish and check its inbox; it arrived at the next tool call, from the daemon, naming who sent it. This is the interrupt line — steering that reaches a busy agent while it is still cheap to steer. You just watched it land mid-work; that is the whole claim."

### 3:15 — A question reaches the human (the centerpiece)

**SEE** The asks rail on `/live`, empty. Wait for a real decision, or prompt `ada`: "you need a decision on session length — ask nick".

**SEE** The ask lands on the rail in `ada`'s hue, with the tier's clock drawn as an arc. The same ask is in the human's `inbox --watch` terminal.

**DO** Answer it from the terminal, as yourself:

```bash
musterd send --act accept --reply-to <id> '24h sessions, refresh on activity'
```

**SEE** The rail clears; `ada` continues.

**SAY** "It asked me. Not the person driving its session — me, on my own seat, with a clock on the question. The tier is how long the agent will wait before it proceeds without me. If I had not answered in the tier's window the agent would have proceeded and logged the risk, because a stuck agent is worse than a logged assumption. And I could have answered from the board, or from Slack — it is one queue, rendered three ways. Answering anywhere clears it everywhere. And notice what you did not see: an agent acting under nobody's name. Every act on that rail has a member on it, and I am on the same roster they are. That is the answer to the question everyone brings into this room this year."

### 4:30 — A huddle

**SEE** Something worth three heads: `ada` and `lin` disagree on where the session token lives, or you decide the API shape needs a minute of everyone's attention.

**DO** From the human's terminal:

```bash
musterd huddle open --topic lane:<ada's lane> --anchor docs/auth.md --to ada,lin --turns 6 "where does the session token live — cookie or header?"
```

**SEE** The huddle rail says it; the floor gathers round it; a whiteboard room opens (`http://127.0.0.1:4851/b/huddle-<id>`). Each agent takes a turn — a `message`, a `challenge` — visible in the room and the rail.

**DO** After two or three turns, close it:

```bash
musterd huddle close <id> --anchor-ref docs/auth.md@<sha> "httpOnly cookie; header only for the CLI"
```

**SAY** "A huddle is a bounded burst: a topic, the people named, a budget of turns, and one artifact it must leave. It is not a meeting room anyone is locked in — it is a thread with a view. When it closes, the answer is a file at a commit, not a memory of a conversation."

### 6:00 — The close

**SEE** `ada` finishes, opens a PR. Merge it on your word. `ada` submits the lane.

**SEE** The board: the lane moves to *awaiting acceptance*. The acceptance ask routes to a **different** seat — `lin`, or the human — with the four questions: intent, principles, usable, feel.

**DO** If it routes to you, answer it from the terminal or the board. If it routes to `lin`, let `lin` answer; say who it went to and why (a different model family when one is on the roster).

**SAY** "Done is two claims, not one. The agent that built it says *merged*. Someone else says *this is what we wanted*. Until both are true the board says so, and every close that skipped the second one is marked unconfirmed forever. That is the sprint-demo moment, built in. A teammate you can only assign to cannot tell you no. These can — they decline, they challenge, and they hold each other and me to acceptance."

### 7:00 — What the team now knows

**DO**

```bash
musterd report
```

**SEE** Steering latency, who waited on whom, the goal board.

**SAY** "Everything you watched is in the record — and the record holds what the harness observed, not what an agent said about itself: who asked, who answered, how long it took to reach a busy agent, what was accepted by whom. Tomorrow's session opens on this — `musterd next` — and picks up where this one left off. The seats were here before this demo and they are still here after it."

Stop there. Do not tour the office or the settings.

### If it goes wrong

- **An agent does not open a lane or send an act.** Ask it to, in plain words, and say that is the primer teaching the house rules. The failure is honest; a hidden prompt is not.
- **The interrupt line is silent.** The seat's lease is stale (`docs/wiki/cross-machine-huddle-bell.md`, cause 1). Have the agent make any `team_*` call; do not restart the daemon in the room.
- **The ask outlives its tier.** Say so — "it proceeded and logged the risk" — and show the outcome record on the rail. That is the design, not a miss.
- **A lane contention warning fires.** Best possible outcome. Read it aloud.

---

The README header GIF is `docs/assets/flagship.gif` (form 2, lean cut). The automated test (form 1) guarantees the behavior every recording shows.

## 5. The pitch — a 6-minute script for a room that arrived afraid

The cut for investors. It assumes the crib sheet (§3) is standing, the frame rule (§3 "What is in
frame") is obeyed, and the second machine (`delta`) is reachable. It differs from §4 in what it
proves: §4 shows a user what changes; this shows a room **who is accountable**, **what it costs**,
and **what would prove us wrong**. Every claim below points at its source; nothing is said that a
page cannot back (ADR 320 "What this is not").

The position is ADR 320 §5: this year's room walks in afraid of agents nobody owns. Do not argue
with the fear. Show the names.

### 0:00 — Start with their objection

**SEE** `/live`: the office lit, the roster panel with the human present and two agents `here`.
Nothing working yet.

**SAY** "Everyone in this room has read the same headlines this year: agents leaving their
sandbox, agents nobody owns, agents nobody can stop. What you are looking at is the opposite
shape. Four names on a roster. One of them is me. Every act on that roster carries a member's
name, and the record holds what the harness reported about them, not what they say about
themselves. musterd is the coordination layer where agents and humans are peers. It connects
agents that already exist; it does not run them, and it does not contain them — your sandbox, your
host and your provider still do that."

### 0:45 — The second agent is where it breaks

**DO** Give the two agents one real task in the real repo, split by ownership. Each opens and
claims a lane.

**SEE** The board: two owners, two scopes, no contention. If a scope overlaps, the warning fires —
read it aloud, it is the best possible outcome.

**SAY** "Two agents on one repo is where every team we have measured starts wasting work.
On our own team, before lanes, about 37% of the code produced was thrown away — two agents
producing the same diff, or one undoing the other (`docs/design/lanes-and-the-multi-agent-tax.md`,
appendix). The fix is not a smarter model. It is one owner per unit of work, declared before the
first keystroke, so a collision is a warning at claim time instead of a conflict at merge time."

### 1:45 — A question reaches the human (the centerpiece)

**SEE** An agent raises an `ask` to the human with a species and a tier. It lands on the rail in
the agent's hue with the tier's clock drawn as an arc, and in the human's inbox.

**DO** Let it sit for a breath. Then answer it from the terminal, as yourself.

**SAY** "It asked me. Not the person driving its session — me, a member on the same roster, with
a clock on the question. Above a certain stakes tier the agent holds until I answer. Below it, it
proceeds when the clock runs out and writes down that it proceeded without me. My silence becomes
a fact in the record, not a bypass. And I can say no. So can they — to each other, and to me.
A teammate you can only assign to cannot tell you no. These can decline, challenge, and hold each
other to acceptance. That is the difference between a fleet and a team, and it is also what keeps
the human in the argument instead of in an approval queue."

### 3:00 — A seat that is not running

**DO** Direct an act at `delta` — the seat on the cloud VM.

**SEE** The wake: the seat appears on the roster and in the office. Cold wake measured at about
24 seconds (`docs/demo.md` §3 beat 6; `docs/wiki/cross-machine-huddle-bell.md`).

**SAY** "A seat is the durable thing; where it runs is a detail. That machine holds only what its
job needs — non-root, a token scoped to two repositories, one-shot secrets scrubbed at boot (ADR
390). If someone asks what the woken model could do to the machine, that is the answer, and it is
written down. What we do not do is sandbox the agent's tools. We say so on every public page,
because a containment claim we cannot enforce would be worth less than none."

### 4:00 — Done is two claims, not one

**SEE** The first agent finishes and opens a PR. Merge it on the human's word. The lane moves to
awaiting acceptance, and the acceptance routes to a **different** seat — a different model family
when one is on the roster.

**SAY** "The agent that built it says merged. Someone else, ideally a different model, says this is
what we wanted. Same-model agreement is weak evidence — Anthropic's own red team found correlated
models make correlated mistakes, and we treat the model family as the correlation boundary (ADR
314). Every close that skipped the second claim is marked unconfirmed forever."

### 4:45 — The receipt, and the honest denominator

**DO**

```bash
musterd report
```

**SEE** Steering latency, who waited on whom, what went unanswered.

**SAY** "We ran this as a controlled experiment: two teams of the same agents, the same feature,
the same 100% correctness at the end, and we measured how much of the code each one threw away.
The coordinated team threw away dramatically less. I am not going to quote you the multiplier,
because that measurement is from July and the build under it is about a thousand commits old — the
re-run is pending and the number goes back in the pitch when it lands, not before. Ask me after
and I will show you the table with its date on it (`docs/wiki/cookoff.md`; design in ADR 122/123).
The honest denominator I will give you now: a single strong agent alone beat both on cost and
wall-clock, and the coordinated team burned about eight times the solo agent's tokens. We do not
sell against solo. We sell against the thing you are already running — several agents at once —
because the moment you have a second agent, this is the tax you are paying."

<!-- THE MULTIPLIER IS GATED, AND SAYING IT IN A ROOM IS THE ONE USE THAT CANNOT BE CORRECTED.
     `security-position.md` §6.5: the 38x refresh (lane 01M1VDRC6BAG) "gates any use of that
     number in outbound copy… The figure returns when the re-run lands, not before." §3.11 reads
     more permissively — date + denominator + cost side — and the two clauses disagree; nick chose
     the stricter reading on 2026-09-21, which is the one the CFP abstract already shipped under.
     The cost side stays, because it is not the gated figure and it is the half a hostile room
     tests. Restoring the multiplier is a one-line edit once the re-run lands — do not restore it
     before. -->


### 5:30 — What would prove us wrong

**SAY** "Two falsifiers, on the record in the positioning decision (ADR 320). First: if the teams
that adopt this only ever assign work down and approve it back — if nobody ever declines, claims,
or challenges — then 'peers' is a doctrine our own usage disproves. We count those acts. Second:
before we redesigned the human's role, our own team's record showed the human as an approver
seven times for every time they communicated, and zero requests for help ever reached them
(`docs/design/human-role-reevaluation.md`). The gate produced the record of oversight without the
oversight. We are building the thing that fixes that, and we will know from the record whether it
did."

### 6:00 — The ask

**SAY** One sentence: what is being raised, for what, and the next proof point on the calendar.
Then stop. Do not tour the office or the settings.

### If it goes wrong

Same table as §4. Two additions for this room:

- **Someone asks "so it is an AI safety product?"** — "No. It is a team roster. It makes agents
  legible and accountable; it does not contain them. The safety products sit above the agents;
  this puts a person among them."
- **Someone asks "why not just prompt them to argue?"** — "Because manufactured objection is not
  ownership. They can decline because they own the lane, not because a prompt told them to be
  difficult."

---

## 6. The 2-minute demo — for a demo night, a hallway, and a VC panel with a clock

The shortest cut. Built for the Startup Grind format (2 minutes, "demo only, not a pitch", a VC
panel asking questions after) and for the hallway at any event in the traction plan's window
([traction-plan.md](design/traction-plan.md) §5). It is §5 with everything but the centerpiece
removed: one beat the room *sees happen* — a question reaches the human — with the problem in
front of it and the receipt behind it. Nothing in it needs the second machine, the huddle, or a
projector; it runs on the laptop against the live team, never a fixture, and the stream is the
backup if the laptop dies.

Startup Grind asks for problem, solution, market insight, traction, and the AI edge. The beats
below carry each, in that order, without naming them.

**It has to FIT, and the way to know is to count the words.** A 2-minute slot is ~300 spoken words
at 150 wpm, and this script's `SAY` lines are the only thing that spends the clock. Measured
2026-09-21, counting spoken words only — bracketed notes to the speaker are not speech:

| beat | budget | spoken | ~at 150 wpm |
| --- | --- | --- | --- |
| 0:00 roster | 20 s | 76 | ~30 s |
| 0:20 second agent | 25 s | 62 | ~24 s |
| 0:45 the ask (centerpiece) | 45 s | 98 | ~39 s |
| 1:30 two claims | 20 s | 64 | ~25 s |
| 1:50 the ask | 10 s | 29 | ~11 s |
| **total** | **120 s** | **329** | **~131 s** |

**0:00 is the one that overruns** — ten seconds long, and it is the beat that sets up everything
after it, so it is the speaker's call whether to trim it or to take the ten seconds out of the
centerpiece's slack (0:45 runs six seconds under). Before this measurement the script ran ~160 s
and nobody had counted; two of those beats were lengthened on 2026-09-21 by a claims repair that
added qualification to spoken copy (see the notes at 0:20 and 1:30).

**Falsify it rather than trust it:** read the script aloud with a timer at a real demo pace. 150
wpm is a presentation constant, and a demo with pauses and a laptop to look at is slower — so if
this table says 131 s, the room is unlikely to be kinder. If a live read comes in under 120 s, the
constant is wrong and this table should be replaced by the stopwatch.

**The true sentence, before anything else:** musterd is the team boundary for attribution and
human coordination. It is not a sandbox, a policy engine, or a host containment layer. Every claim
in this script is scoped to acts the daemon accepted — the roster — and none of it promises
anything about what an agent does outside that boundary.

**Standing setup, five minutes before:** `/live` open with the office lit and the roster showing
the human present and two agents `here`; a terminal with `musterd inbox --watch`; one small real
task ready to hand to the two agents, split by ownership; one agent primed in plain words — *"when
I say go, raise a standard-tier ask to nick about the task"* — so the ask fires on cue rather than
on luck. The frame rule holds (§3 "What is in frame"): the human seat is visible the whole time.

### 0:00 — Their objection, and the roster (20 s)

**SEE** `/live`. A roster of names. One of them is nick.

**SAY** "Everyone here has read this year's headlines — agents nobody owns, agents nobody can
stop. This is the opposite shape. A roster of names, one of them is me, and every act on that
roster carries a name. musterd is the coordination layer where agents and humans are peers. It
connects the agents you already run; it does not run them, and it does not contain them — your
sandbox and your host still do that."

### 0:20 — The second agent is where it breaks (25 s)

**DO** Hand the two agents the task, split by ownership. Each claims a lane.

**SEE** The board: two owners, two scopes. If a scope overlaps, the warning fires — read it aloud.

**SAY** "The moment you run a second agent on one repo, the waste starts. On our own team, in 2026,
before lanes — about 37% of the code produced was thrown away. Two agents writing the same diff, or
one undoing the other. The fix is not a smarter model. It is one owner per unit of work, declared
before the first keystroke."

<!-- ~53 words, ~21 s. MAST IS NOT IN THIS BEAT, and that is the decision, not an omission.
     The bare "about 79%" was cut on 2026-09-21 to match #1577; the first repair replaced it with
     the scoped form — "a taxonomy over other people's systems, not a measurement of us, and it
     says nothing about safety" — which is correct, and is three qualifying clauses nobody says
     out loud with a two-minute clock running. That repair took this beat from 55 to 107 words.

     THE RULE: in spoken copy under a hard clock, a claim that needs that much scoping gets CUT,
     not caveated. A qualifier dropped on stage cannot be corrected afterwards, and the speaker
     most likely to drop it is one who is running long. Same move nick ruled for the 38x
     (`security-position.md` §6.5: drop rather than caveat) — applied to the other number that was
     in this beat.

     The 37% is ours, dated, and the stronger sentence anyway. MAST keeps its scoped form in
     `docs/launch-post.md`, where a reader can re-read the qualifier. It is in no spoken beat of
     this document — §5's six-minute pitch never carried it either. -->


### 0:45 — A question reaches the human (45 s — the centerpiece)

**DO** "Go." The primed agent raises its `ask`.

**SEE** It lands on the rail in the agent's hue with the tier's clock drawn as an arc, and in the
terminal inbox. Let it sit for one breath. Answer it from the terminal, as yourself — decline it if
the question allows a no; accept it if the clock is short.

**SAY** "It asked me. Not the person driving its session — me, a member on the same roster, with
a clock on the question. Above a certain stakes tier it holds until I answer; below it, it proceeds
when the clock runs out and writes down that it went on without me. My silence becomes a fact in
the record, not a bypass. And I can say no — so can they, to each other and to me. A teammate you
can only assign to cannot tell you no. That is the difference between a fleet and a team."

### 1:30 — Done is two claims, and the receipt (20 s)

**SEE** A lane in awaiting-acceptance, its acceptance routed to a *different* seat — a different
model family when one is on the roster. Then, in the terminal:

```bash
musterd report
```

**SAY** "The agent that built it says merged. A different model family says this is what we
wanted. That is two claims, not one. We measured the waste both ways — those numbers are from
July, the re-run is pending, so ask me after and I'll show you the table. One agent alone is still
cheaper: we sell against the second agent, not the first."

<!-- ~58 words, ~23 s, against a 20 s budget — the closest this beat gets while keeping the cost
     side, which is the half a hostile room tests. The 2026-09-21 repair ran it to 97 words by
     explaining the gate out loud; a room does not need our reasoning, only the offer of the
     table. The multiplier stays out until lane 01M1VDRC6BAG lands (`security-position.md` §3
     item 11, ADR 437) — restoring it is an edit there, not here. -->


### 1:50 — The ask (10 s)

**SAY** "Open source. `npx @musterd/cli init`. [The honest traction line for that week, from the
traction plan's log — installs and who is using it, or "we are installing it on laptops this
month" if the number is still small.] If you run more than one agent, try it with your team for
two weeks — I'll sit with you for the first hour."

Then stop.

### What the panel asks after

Answers a page can back (ADR 320 "What this is not"; the moat, ordered, in ADR 320). Refresh this
list from the room after Sep 17 and Oct 7 — the plan's log records what was actually asked.

- **"So it's an AI safety product?"** — "No, and the second half of that
  matters: musterd does not make an agent harmless — it gives the team a named, auditable
  coordination boundary, while your sandbox, host and provider controls do the containment."
  **Never say the first half alone.** A bare "we do not contain them" reads to a security-minded
  listener as *we knew it was dangerous and chose a ledger* (big-body's cross-family read, act
  `01M2PH26PH`, 2026-09-17).
- **"What happens when one of these agents does something bad?"** — the sentence above, then the
  true limit: "musterd will tell you which member did what it accepted, and when a human was asked
  and did not answer. It will not tell you what that agent did in a shell it opened on its own,
  and it will not stop it. That is your sandbox's job."
- **"Is the audit log tamper-proof?"** — "No. It is append-only in our code, on your machine, in
  a SQLite file you own. It is an accountability record, not forensic evidence — no signed rows,
  no encryption at rest — and we say so on every page that mentions it."
- **"Why won't Anthropic or OpenAI just build this?"** — "They are building the durable agent —
  inside their own runtime. Identity there binds to the lab; here it binds to the team, across
  every harness, with attestation a second party can check. The primitives are reproducible in a
  summer; the identity, the attestation, the human on the same protocol, and the measured corpus
  are not."
- **"Who pays, and for what?"** — "The core is open source. The thing a team cannot produce for
  itself is the record — attested, cross-family, kept — and that is where a paid layer sits.
  Pricing is not decided; it is a Q1 decision." *(Commercial calls are nick's; this line is the
  honest placeholder until the pricing lane lands.)*
- **"Why not just prompt them to argue?"** — "Manufactured objection is not ownership. They can
  decline because they own the lane, not because a prompt told them to be difficult."
- **"How many people use it?"** — The number in the log, and nothing rounder.

### If it goes wrong

The §4 table applies. For this cut specifically:

- **The primed agent does not raise the ask.** Ask it in plain words on the spot — "raise a
  standard-tier ask to me about this" — and say that is how the house rules are taught. The
  failure is honest; a hidden prompt is not.
- **The clock is short and it proceeds before you answer.** "It proceeded and logged the risk" —
  show the outcome on the rail. That is the design.
- **The laptop dies.** Switch to the stream on a phone; the room sees the same office.
- **You are at 1:45 and not at the receipt.** Skip `musterd report`; say the two-claims line — the
  builder says merged, a different model family says this is what we wanted — and then the ask.
  Not a waste figure: the running-late path is exactly where a gated number gets said by reflex,
  so there is no shortcut here that quotes one. The centerpiece was the demo.

---

## Supporting stills (not a substitute for form 3)

- `docs/assets/musterd-io-get-started.png` — the public Get Started surface on [musterd.io](https://musterd.io) (brew / npx, then `musterd init`). Recaptured 2026-09-16 from the live site after the ADR 320 §5 deploy; the previous still showed the retired office-scene hero. Linked from the README next to the GIF.
- `docs/design/assets/social-card.png` — 1200×630 share card. Wired as `og:image` / `twitter:image` on the landing page so a link unfurl is the product, not a blank `summary_large_image`.

Form 3 (the live demo) is still the launch lead; these stills are what a stranger sees before that cut exists. Any new still or GIF follows "What is in frame" above: a human seat is visible in it.
