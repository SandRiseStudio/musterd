# Research foundation — why musterd bets on human-agent collaboration

> **Living document.** The empirical ground under musterd's founding thesis. This is _evidence for_ the thesis, not the thesis itself (that lives in `README.md` and `human-agent-dynamics.md`). Corrections via ADR + smallest correct change; update this doc in the same commit. Status: **recorded 2026-06-17**.

> **Ingest side of the research practice (ADR 056).** This doc is the canonical home for the _external_ research musterd consumes. The **research radar** (plan: `research-radar-plan.md`) is the intended feed — today M1–M3 are hand-run (`pnpm radar:sweep` / `--triage`); weekly digest emit + schedule (M4–M5) are not built yet, so nothing auto-appends here. When a finding would change a decision it graduates to an ADR + roadmap item (human gate). The _produced_ side — musterd's own findings, dataset-first and MAST-in-the-wild — lives in `../research/`.

musterd's founding bet — *named, persistent teams where humans are members, not approvers, and agents are teammates, not tools* — is not a hunch. It rests on a specific result that this doc records so the rationale stops being implicit and the plan can be checked against it.

## The result

**Collaborative Gym (Co-Gym): A Framework for Enabling and Evaluating Human-Agent Collaboration** — Shao, Samuel, Jiang, J. Yang, D. Yang (Stanford / CMU), [arXiv:2412.15701](https://arxiv.org/abs/2412.15701) (v5). Code + data (MIT): [github.com/SALT-NLP/collaborative-gym](https://github.com/SALT-NLP/collaborative-gym).

Co-Gym evaluates three agent architectures — **fully autonomous**, **collaborative**, and **collaborative + situational-planning** — across three real tasks (travel planning, related-work writing, tabular analysis), in both a simulated condition (LLM user simulator) and a real condition (99 participants, 150 trajectories, 6.3k actions).

### What it found

1. **Collaboration beats autonomy on outcome quality.** Against fully autonomous agents, the best collaborative agent won, by real-user preference: **Travel 86%, Tabular 74%, Related Work 66%**. The opening line names the goal musterd inherits: machines that act as _"teammates rather than mere tools."_

2. **The notification protocol _is_ the mechanism — not a nicety.** Ablation: force turn-taking by removing the notification protocol → win rate collapses to **30%**; non-turn-taking with notifications → **70%**. Async coordination plus _being notified_ (rather than having to watch) more than doubles outcomes. This is the single strongest design validation musterd has — and the place it is most under-built (see §"Where musterd has under-invested").

3. **Dual control is what humans actually do.** Users voluntarily spent **21–32%** of their actions editing the shared workspace _directly_, not just messaging the agent. "Humans are members, not approvers" is measured behavior, not aspiration — highest where the human had stronger domain expertise.

4. **The dominant failure modes are about keeping the human in the loop.** Real-condition error taxonomy (150 hand-annotated trajectories):

   | Category | What fails | Real | Simulated |
   |---|---|---|---|
   | **Communication** | acting without informing; no progress/completion updates; weak post-action summaries (C.1/C.3/C.5) | **65%** | 80% |
   | **Situational Awareness** | treating each request as isolated; repetitive queries; not handling multiple messages coherently (SA.1–3) | **40%** | 47% |
   | Planning | incoherent/omitted/repeated actions over long horizons | 39% | 43% |
   | Environment Awareness | missing operational constraints/resources | 28% | 13% |
   | Personalization | not adapting to in-session preferences | 16% | 11% |

5. **Trade-off, stated honestly.** Under a step limit, collaborative agents have a _lower delivery rate_ (coordination overhead; sometimes don't finish in budget) but _higher quality among delivered_ tasks. The quality gains depend on a **situational-planning** module — the agent reasoning over full state (task, chat, action history, observations) to choose _act vs. message vs. wait_ before acting.

## How Co-Gym maps onto musterd

The framework is close to isomorphic with musterd's model — musterd is, fairly literally, **Co-Gym's coordination protocol made persistent and cross-harness**:

| Co-Gym | musterd |
|---|---|
| "teammates rather than mere tools" | **Member, not tool**; humans are members, not approvers (README principle 1) |
| Collaboration acts: `SendTeammateMessage`, `WaitTeammateContinue` | **Acts** — `message`, `wait`, plus a richer set: `status_update` / `request_help` / `handoff` / `accept` / `decline` |
| Non-turn-taking, async; send without waiting for a reply | **Envelope + durable inbox + presence** — coordination outlives any turn or session |
| Notification protocol (4 event types: shared/private obs, new message, inactivity) | partial: presence + inbox + `inbox --watch`; **the human-reachability half is deferred** (v0.3 notification tiers) |
| Public vs. private observation | **need-to-know visibility projection** (v0.3, `membership-model.md` / `security.md`) |
| Dual control (human + agent act in one workspace) | CLI human surface + MCP agent surface on one team |
| In-session "Scratchpad" memory | musterd goes further: a **durable, attributed log** — context survives the session |

Two places musterd is structurally _ahead_ of the paper's agents:

- **Persistence directly attacks the #2 failure class.** Situational-awareness failures are "treating each request as isolated / ignoring prior interactions." Co-Gym's agents only had an in-session scratchpad; musterd's durable, attributed message log _is_ cross-session memory of the collaboration — and the model dynamics §3 calls "expertise as track record."
- **A richer act vocabulary** makes the Communication failures addressable as first-class verbs: `status_update` (progress awareness, C.1/C.3), `handoff`/`accept`/`decline` (explicit work transfer), `request_help` (knowing when to ask).

## What this commits musterd to

Read alongside `human-agent-dynamics.md` (the philosophy) and `README.md` (the principles). The evidence sharpens priority, it doesn't change the thesis:

- **The human↔agent loop is where the measured value is** — notification/reachability, progress-reporting, knowing when to pull the human in, the human stepping in to co-edit. Build _that_, not just the plumbing that lets agents be members.
- **`status_update` adoption is load-bearing, not cosmetic.** The #1 failure class (65%) is agents not keeping the human aware. musterd's primer + hooks that push status reporting are mitigations of the exact dominant failure; the residual "is anyone making the agent report" gap matters proportionally.
- **A terminal "done" signal for a thread is missing** (also flagged in dynamics §4): C.3 is "no completion notification." There is no act/marker that closes a thread (`accept` ≠ finished), so progress-awareness and the board/insights layer both lack an end state.
- **The honest trade-off is real:** collaboration can cost completion-within-budget for quality. musterd should never _force_ decomposition (README principle 5) and should make the collaboration overhead worth paying — which is precisely the notification + situational-awareness investment above.

## Where musterd has under-invested (the 2026-06-17 course-correction)

The v0.2 launch tail (ADRs 012, 016–020) is almost entirely **agent-side plumbing**: identity, presence, single-active collision handling, workspace binding, init guards. Necessary work — but it built the half Co-Gym treats as table stakes (letting agents _be_ members) and under-built the half it _proves_ is the payoff (the human↔agent interaction loop). The two thinnest spots are exactly the two the ablation/failure-analysis say drive outcomes:

1. **The driving human is invisible** (dynamics §1 / §54 "driver co-presence"). When a human steers an agent inside its session, the roster shows the agent online and the human offline — the one entity certainly present shows as gone. Co-Gym's dual-control finding (humans co-act 21–32% of the time) says the human is a true participant, not a spectator; the roster should say so.
2. **Human reachability** (deferred to v0.3 notification tiers). The ablation says notification is _the_ mechanism (30% → 70%). Today a human only sees an agent's `request_help`/`handoff` if they happen to be running `inbox --watch`. That is the turn-taking-like failure mode the paper measured.

These are tracked in `../implementation-plan.md` §4 as the evidence-backed re-centering, not as new scope creep — the protocol and acts to support them largely exist; what's missing is wiring the loop on the human's side.
