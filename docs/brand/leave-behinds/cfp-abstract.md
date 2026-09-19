# CFP — AI Engineer Code Summit, Nov 10–12 2026

_Submission copy for the speaker CFP (Sessionize), which closes **2026-10-11**
([traction-plan](../../design/traction-plan.md) §10 "Events — where to be"). The talk title is fixed by that plan; the
rest is drafted here so it can be read by a second seat before it is pasted into a form we cannot
edit afterwards._

**The rule this page is written under** is [security-position](security-position.md) §5: the title
may be used **only** with a mechanism and a dated receipt attached, every time. A CFP is the
easiest place in the world to make a claim that outruns the evidence, because nobody checks an
abstract. The numbers below are all from `docs/research/` and all dated in the copy itself.

**The 38× is deliberately absent.** It is gated by §3.11 and §6.5 until the re-run lands, and a
gate that bends for a conference deadline is not a gate. The talk does not need it — the
0/8-vs-8/8 result is the stronger story anyway, because it is about a mechanism rather than a
margin.

---

## Title

> A teammate who can decline: accountability primitives for coding agents

## Abstract (submitted field)

We told three coding agents to coordinate. They didn't. Across two runs on the same eight-ticket
backlog, **zero of eight lanes were ever claimed** and six of six agents soloed the entire thing —
and that was with a primer that actively instructed them to divide the work. Telling agents to be a
team does not make them one.

Then we stopped asking. We put the rule in a gate: an edit to a contended surface is **denied**
unless the agent owns a lane covering it, and costly actions route to a human as a first-class
protocol act. Same tickets, same model, same harness. **Eight of eight lanes claimed, in every
enforced run.** When the gate denied an action, the agents complied — they stopped, raised the
question, and waited. We went looking for route-arounds in the run databases and found none.

This talk is about the primitives underneath that result, and about what they cost. The verbs are
small and boring: claim work and be refused if someone already owns it; **decline**, and have the
work re-route with your reason on the record; accept someone else's work, where the accepting actor
is not the authoring one. Each has a mechanism you can check on your own machine in an afternoon,
and each exists because the version that was only advice produced nothing.

I will also show you the number that argues against me. On a backlog this size, **one agent alone
beats the coordinated three** — it burns about an eighth of the output tokens and finishes faster,
with the same acceptance rate. Coordination is a real cost you pay for a real thing, and the honest
pitch is never against a solo agent. It is against the three agents you are already running without
it.

And there is a boundary I want to be precise about, because this is the room where it matters:
naming the work that goes through the team is not containing the agent. None of this sandboxes
anything, sees a tool call the protocol never touched, or stops a bad step. It records who claimed
what, who refused, and who accepted it — which is the layer the incidents of the last two years
actually went missing at, and a different layer from the one most of us are building.

## Takeaways (three, as the form asks)

1. **Guidance does not produce coordination; structure does.** Two runs of advice produced 0/8
   lanes claimed. The same backlog under enforcement gates produced 8/8, repeatably, with no change
   to the model or the prompt.
2. **"Decline" has to be a protocol verb, not a comment.** An agent that can only complain in prose
   has no way to refuse, and a human who can only approve is a bottleneck rather than a peer. The
   design question is which acts exist, not how the agent is prompted.
3. **Coordination costs roughly 8× the output tokens of a solo agent, and it is still worth it at
   N>1 — but only there.** Know which regime you are in before you buy the machinery. If your
   bottleneck is the bill and not the collisions, do not do this.

## Speaker bio (draft, nick to approve)

nick sanders builds musterd, an open-source coordination layer where coding agents and the people
working with them are members of the same team — named, persistent, and able to refuse each other's
work. He runs it on his own repositories every day, publishes the experiments that did not work
alongside the ones that did, and streams the team building itself.

## Notes for the submitter, not for the form

- **Session format:** single 20-minute talk. The result fits; a workshop does not, since the
  apparatus needs a machine per cell.
- **The demo beat, if there is stage time:** the two-minute cut in [demo.md](../../demo.md) — a
  question reaches a human, the human declines, the work re-routes, and every act carries the name
  of the member the daemon accepted it from. It is the only beat that cannot be told as well as it
  can be shown.
- **Every number in the abstract, with its source:** 0/8 lanes claimed and 65.5% / 82.6% wasted
  work, 2026-07-17 guidance A/B; 8/8 lanes claimed in every enforced run, cells D3–D5, 2026-07-19
  onward; compliance under deny with zero route-arounds,
  [research/007](../../research/007-compliance-under-deny-retro-audit.md), audited 2026-07-21 and
  answered unconfounded 2026-08-01; the solo comparison — ~7.7× output tokens and slower
  wall-clock at equal acceptance —
  [research/006](../../research/006-enforcement-induces-coordination-cookoff-pilot.md) §3. I
  rounded 7.7× to "about an eighth" and "roughly 8×" in prose; if a reviewer asks, the figure is
  7.7 and it is a mean over two runs.
- **What a hostile reviewer will push on**, and what to say: the sample is small (two guidance runs,
  three enforced), one fixture, one model. That is true and the abstract does not hide it — the
  claim is about a mechanism reproducing, not about an effect size. Say so plainly; the talk is
  more credible for it.
- **Second-seat read owed before submission.** This is high-stakes copy under the role's definition
  of done, and it is the one piece in this set that cannot be corrected after it ships.

