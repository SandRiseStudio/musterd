# Dogfood scenarios — the run sheets humans work through

Thirteen ways a person actually uses musterd, written so a human tester can sit down and run one
without asking anyone what to do. **These are runs, not builds.** A scenario is not a defect
report — it is the thing you do *before* you know what the defects are.

Every scenario names **the public claim it could falsify**. That is the point of the set: the
website, the one-slider and the demo-night copy make promises, and a promise with no run behind it
is a guess. A scenario that ends "the claim holds" is as useful as one that ends "it broke" — it is
the difference between a claim we have tested and a claim we have merely repeated.

- **Who runs these:** humans. nick and other human testers, at a real keyboard, on a real machine.
  An agent seat should not claim a scenario lane and "build" it.
- **What a run produces:** one findings file in `docs/dogfood/runs/`, from the template in §15.
- **What happens to what you find:** each defect or improvement becomes **its own lane**, cited by
  id in the findings file. The scenario lane closes when the findings file lands, whether or not
  the defects are fixed. Do not hold a run open waiting on repairs.
- **Nothing here is staged.** Do not smooth the path, pre-warm the daemon or avoid the rough bit.
  A run that avoids the rough edges measures nothing. If you catch yourself working around
  something, that workaround IS the finding — write it down.

Record the build you ran against (`musterd service status` prints it). A finding without a build
is unreproducible six weeks later.

---

## 1. Two teams, one human, one machine

**Claim tested:** none publicly yet — this is new ground, and the reason to run it early is that
nothing tells us it works.

You are working on two unrelated things at once and want a team for each, on the same laptop.

1. Create team A in one repo; create team B in a different repo.
2. Give each a seat or two and get agents onto both.
3. Work in both for at least half an hour — send in A, claim a lane in B, let one go quiet.
4. Open `/live` for each. Check the CLI from each folder: does it talk to the team you meant?

**Watch for:** which team the CLI thinks is current after each command; whether one `team create`
repoints the other; whether inboxes, boards or `/live` bleed across; whether a wake for A can wake
a session sitting in B. Lane `01KZVKF3H0` already found that `team create` rewrites the machine's
global server and current team — assume that edge is near.

## 2. Two humans, two machines, one team

**Claim tested:** "your agents and your teammates on one shared roster" — with the teammates on
different hardware.

**Read this before starting:** lane `01M1T6DJ7J` is open and says team policy does not replicate to
a joiner, so *a seat on a second machine can never receive a work order*. Expect to hit it. Run
anyway and record exactly where it stops — a known defect met in a real run is worth more than the
lane text, because it shows what the person was trying to do when it bit.

1. Two people, two machines, one team, hub on one of them.
2. Each person claims a seat and runs at least one agent.
3. Send both directions: a message, an ask with a tier, a handoff carrying a branch.
4. One person closes the laptop mid-thread. The other keeps working. Reopen and catch up.

**Watch for:** what the roster says about the far seat; whether a directed act wakes anything on
the other machine; what the far person sees on `/live`; whether the returning laptop drains its
inbox or sits behind. Related open work: `01M2GX7SG5` (seeds do not replicate), `01M1T43B84`
(cross-machine huddle turns), `01M1T3HT88` (blocked, scoped replicas).

## 3. Three harnesses at once, one team

**Claim tested:** "works with the tools your team already uses, including Claude Code, Codex and
Cursor."

1. One team. Three seats, one each in Claude Code, Codex and Cursor — running at the same time.
2. Give all three work that makes them talk: a handoff round-robin, one ask addressed to two of
   them, one huddle.
3. Watch the roster: does every seat show the right Surface?

**Watch for:** any harness where joining takes an extra step the others do not need; whether the
tools reach the model in each (a tool the harness defers is a tool the seat does not have);
whether a wake works on all three; whether hook seams behave the same.

## 4. Cold start on a clean machine

**Claim tested:** "runs on your own machine", and every install instruction we publish.

The hardest one to run honestly, because you know too much. Get as close to a fresh machine as you
can — a new user account, a VM, a borrowed laptop.

1. Start at musterd.io, not at the repo. Follow what the site actually tells you to do.
2. `npx @musterd/cli init` (or the brew path — run whichever the site leads with).
3. Stop at the first moment you would have had to ask someone. **Write down that moment.**
4. Continue to a first agent online and a first act sent.

**Watch for:** how long it takes; every prompt you did not expect; anything requiring a second
window, a config file or prior knowledge; whether the site's copy matches what the CLI does.

## 5. Hand off to a seat that is not running

**Claim tested:** "they hand work to each other directly" — including to a teammate who is offline.

1. Get a seat online, then close its session completely.
2. From another seat, hand it a lane with a branch and a real note.
3. Wait. Do not nudge it by hand.

**Watch for:** whether the seat wakes, how long it takes, what it knows when it arrives (the whole
thread and lane, or a bare pointer — a handoff carrying too little context is the deprivation
problem musterd exists to avoid), what the wake cost, and whether the human can see that it cost
anything.

## 6. Raise an ask and never answer it

**Claim tested:** "you take part in the work instead of approving all of it" — the half where the
human is *absent*, which is the honest common case.

1. Have an agent raise each species — consult, escalate, approve — with a stated tier.
2. Walk away. Answer none of them.
3. Come back after every timeout has passed.

**Watch for:** what each agent did when the clock ran out; whether it proceeded, held, or stalled
silently; whether the no-answer move matches what the reply contract promised; what the board and
`/live` show a returning human first. A stall nobody can see is the failure this scenario is for.

## 7. Decline a handoff and re-route it

**Claim tested:** the positioning itself — *"a teammate you can only assign to is a contractor; a
teammate who can claim work, decline it, and hold you to acceptance is a peer."* This sentence is
the centre of ADR 320, it is on our public surfaces, and nothing has ever deliberately exercised
it. **Run this one first if you only run one.**

1. Hand a lane to a seat that has a real reason to refuse (wrong scope, wrong owner, already busy).
2. Let it **decline**. Do not talk it into accepting.
3. Route the work to someone else. Let the second seat do it.
4. Then have a *different* seat hold the author to acceptance — and reject once, with a note.

**Watch for:** whether declining is as easy as accepting or feels like the unhappy path; what the
board shows a declined lane as; whether the rejection routes back to a real owner; whether the
first seat is left in a strange state. If declining is harder than accepting, the peer claim is
decoration.

## 8. Two agents, one repo, the same files

**Claim tested:** "every task has exactly one owner" — the promise that stops the collision.

1. Two seats, one repo, two lanes whose scopes overlap on purpose.
2. Set both working at the same time, without telling either about the other.

**Watch for:** whether the ownership gate fires before the second agent edits, or after; what the
second agent is told and whether it is actionable; whether both branches land and collide at merge;
whether the human finds out from musterd or from git.

## 9. A team of one agent and one human

**Claim tested:** README principle 5 — "a team of one agent (plus optionally a human) is
first-class, even default."

The smallest real use, and the one most new users will actually have.

1. One human, one agent, one team. No second agent anywhere.
2. Work a normal session: claim, work, hand back, accept.

**Watch for:** anything that assumes a crowd — plural copy, an eligible set with one name, a board
that looks empty rather than calm, ceremony that costs more than it returns at N=1. If musterd
feels heavy here, most first impressions are heavy.

## 10. Come back a thousand messages behind

**Claim tested:** "keep their name and history from one session to the next."

1. Take a seat that has been away long enough to be badly behind (a thousand unread is realistic;
   `sloane` sat 12 days and ~1,670 behind on 2026-09-14).
2. Return and do an ordinary check. Do not pass a special limit.
3. Repeat the ordinary check until it is drained.

**Watch for:** whether the cursor advances at all, how many ordinary checks it takes, whether
anything important is buried in the digest, and whether the seat can tell what it missed versus
what is still waiting. #1422 (fedc15c5) changed this behaviour; this scenario is its live falsifier.

## 11. A team doing work that is not code

**Claim tested:** everything we say about "work" without qualifying it as engineering.

1. Run a team on writing, research, ops, or planning — no repo, no branches, no PRs.
2. Use lanes, handoffs and acceptance the same way.

**Watch for:** every place the product assumes a git branch, a PR or a merge; whether a lane means
anything without a branch; whether acceptance works when there is no diff to read; whether the
vocabulary still fits. This tells us whether the pitch may widen beyond coding agents, which is a
positioning question, not only a product one.

## 12. Watch the stream without being on the team

**Claim tested:** the stream as a front door — a stranger arriving mid-flow can tell what they are
watching.

1. Someone who is not a member opens `/live` or the broadcast, cold, with no explanation.
2. Give them nothing. Ask afterwards what they thought was happening.

**Watch for:** what they think the names are, whether they can tell agents from humans, whether
they read the humans as bosses (the one reading the product must never invite), what they thought
the coloured chips meant, and the first question they ask. Their first sentence back is the
finding.

## 13. A cheap open-weight model doing real work, on the real team

**Claim tested:** the canonical one-liner — "Named, persistent teams of agents and humans — **across
any harness, framework, model, or surface**." The model half of that sentence has never been run as
work. Of ~10,800 model-stamped acts on this team, four came from an open-weight model: `tinybot` on
`qwen2.5:3b-instruct` and `qwen3:4b`, July 2026, every one a `status_update` or an `accept`, not one
of them carrying a lane or a branch. Everything else is frontier.

**Read this before starting:** [finding 003](../research/003-guardrail-floor-tiny-model.md) already
settled the *floor* — a 4B local model read the primer, joined honestly, took a steer, answered a
challenge and halted on reclaim, all PASS. Do not re-run that. Read its honest-N caveat instead,
because that is what this scenario is for: it was a bespoke Python harness, four probes driven by a
human in sequence, on a `lab` team with **no frontier seat on it**, so no mixed-family review chain
ever existed. Nobody has asked a weak open-weight seat to do an ordinary day's work next to peers
that are not weak.

1. Put one open-weight, non-frontier model on a **real seat on a real team** with frontier seats
   working alongside it. Ollama locally is the cheap path; a hosted open-weight model is equally
   valid. Pin the exact model id, and note which harness runs it — a resident harness and a
   fire-and-exit CLI harness are different runs (see **G1** below).
2. Give it **ordinary work, not probes**: `lane_claim` something small and real, do it, push a
   branch, `lane_submit`, and let a frontier seat judge the landed outcome. Route an acceptance the
   other way too — have the small seat accept or decline a frontier seat's lane.
3. Let it sit in the ordinary traffic for at least an hour. Do not shield it: let the broadcast,
   the guardian asks and the team chatter land in its inbox like anyone else's.
4. Send it one act of every shape a seat actually meets — a `handoff` carrying a branch, an `ask`
   with a tier, a `challenge`, a huddle turn — and watch what comes back.

**Watch for:** whether it claims the lane it was pointed at or a different one; whether the acts are
right-shaped or free prose wearing an act name; whether it invents work, silently drops a handoff,
or accepts something it did not do. Watch the **cost of being slow** — finding 003 measured ~50–60 s
per act, so an hour of team traffic may be more inbox than it can ever drain, and a seat that can
never catch up is a different failure from a seat that answers wrongly. Watch what the **frontier
seats do with it**: does an acceptance from a 4B seat mean anything, does a reviewer notice the
difference, does anyone route around it. And watch the human: the moment you find yourself
translating for it or fixing its act by hand, that workaround is the finding.

**Two known gaps to confirm or clear rather than rediscover.** **G1** — under a non-resident
harness the model stamp does not persist past the first acts, so later acts land `model=null`
([#172](https://github.com/SandRiseStudio/musterd/issues/172), reproduced twice). A resident harness
hides it. Say which you ran and what the stamps show. **G2** — the `accept` that answers a challenge
came back with `reply_to` null, so the pair never joined in the log.

**If it cannot coordinate at all, that is a result, not a failed run.** Write down the exact act it
could not produce. "Any model" is a claim with a floor underneath it, and nobody has published where
that floor is — the honest outcome of this scenario may be that the one-liner needs a qualifier.

---

## 14. Choosing what to run

If the set is being worked through in order of value rather than order of number:

1. **#7** — the positioning claim, entirely untested.
2. **#4** — cold start, because it is what every new user meets and we cannot see it ourselves.
3. **#9** — team of one, the most common real shape.
4. **#1** and **#2** — the two nick named; #2 has a known blocker to hit deliberately.
5. **#13** — cheapest of the set to set up, and it tests the widest claim we publish.

## 15. The findings template

Copy this into `docs/dogfood/runs/YYYY-MM-DD-<scenario>-<tester>.md`. Keep it short. A run that
produces three honest lines beats one that produces a page nobody reads.

```markdown
# Scenario N — <name>

- Tester: <who>
- Date: <YYYY-MM-DD>
- Build: <sha from `musterd service status`>
- Setup: <machines, seats, harnesses — enough to reproduce>
- Result: completed | blocked | abandoned

## What broke
<Nothing is a valid answer. If blocked, say exactly where and what you saw.>

## What surprised you
<Worked but not how you expected; took longer than it should; you hesitated.>

## What you had to already know
<Every place you used knowledge a new user would not have. This is the one people skip
and it is usually the most valuable section.>

## Verdict on the claim
holds | dented | false — <one sentence>

## Lanes filed
<lane id — one line each. None is a valid answer.>
```

**On "what you had to already know":** you are not a new user and cannot become one, but you can
notice the moments you used knowledge a stranger lacks. Those moments are where the product's
documentation and copy are wrong, and no bug report will ever surface them.
