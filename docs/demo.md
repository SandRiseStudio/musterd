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

Sound check: `musterd status` should show the human present and each agent seat `here` (its session open, nothing working), and `delta` as `wakeable · resumable` — not plain `offline`. If it says `offline`, the roster is lying about a seat that can be reached (open lane `01M1T3GWEA`); demo the wake anyway, but expect the label to lag the fact.

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

### 3:15 — A question reaches the human

**SEE** The asks rail on `/live`, empty. Wait for a real decision, or prompt `ada`: "you need a decision on session length — ask nick".

**SEE** The ask lands on the rail in `ada`'s hue, with the tier's clock drawn as an arc. The same ask is in the human's `inbox --watch` terminal.

**DO** Answer it from the terminal, as yourself:

```bash
musterd send --act accept --reply-to <id> '24h sessions, refresh on activity'
```

**SEE** The rail clears; `ada` continues.

**SAY** "It asked me. Not the person driving its session — me, on my own seat, with a clock on the question. The tier is how long the agent will wait before it proceeds without me. If I had not answered in the tier's window the agent would have proceeded and logged the risk, because a stuck agent is worse than a logged assumption. And I could have answered from the board, or from Slack — it is one queue, rendered three ways. Answering anywhere clears it everywhere."

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

**SAY** "Done is two claims, not one. The agent that built it says *merged*. Someone else says *this is what we wanted*. Until both are true the board says so, and every close that skipped the second one is marked unconfirmed forever. That is the sprint-demo moment, built in."

### 7:00 — What the team now knows

**DO**

```bash
musterd report
```

**SEE** Steering latency, who waited on whom, the goal board.

**SAY** "Everything you watched is in the record: who asked, who answered, how long it took to reach a busy agent, what was accepted by whom. Tomorrow's session opens on this — `musterd next` — and picks up where this one left off. The seats were here before this demo and they are still here after it."

Stop there. Do not tour the office or the settings.

### If it goes wrong

- **An agent does not open a lane or send an act.** Ask it to, in plain words, and say that is the primer teaching the house rules. The failure is honest; a hidden prompt is not.
- **The interrupt line is silent.** The seat's lease is stale (`docs/wiki/cross-machine-huddle-bell.md`, cause 1). Have the agent make any `team_*` call; do not restart the daemon in the room.
- **The ask outlives its tier.** Say so — "it proceeded and logged the risk" — and show the outcome record on the rail. That is the design, not a miss.
- **A lane contention warning fires.** Best possible outcome. Read it aloud.

---

The README header GIF is `docs/assets/flagship.gif` (form 2, lean cut). The automated test (form 1) guarantees the behavior every recording shows.

## Supporting stills (not a substitute for form 3)

- `docs/assets/musterd-io-get-started.png` — the public Get Started surface on [musterd.io](https://musterd.io) (brew / npx, then `musterd init`). Linked from the README next to the GIF.
- `docs/design/assets/social-card.png` — 1200×630 share card. Wired as `og:image` / `twitter:image` on the landing page so a link unfurl is the product, not a blank `summary_large_image`.

Form 3 (the live demo) is still the launch lead; these stills are what a stranger sees before that cut exists.
