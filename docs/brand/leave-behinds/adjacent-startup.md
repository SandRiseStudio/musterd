# musterd — you already have a coordination problem; it is currently solved by you remembering

_One page, for a small team shipping with agents. Every claim here is checkable; the ones that are
not yet true are marked as such._

---

**Where this starts.** You have three agents going in three windows. One is refactoring the thing
another is rewriting. You find out at the merge. The fix, today, is that you hold all of it in your
head and say something in time — which works until the day you are in a meeting, or asleep, or
there are five windows instead of three.

That is a coordination problem, and it is the one thing you cannot fix by picking a better model.

**The sharp end of it.** In July 2025 a coding agent deleted a production database during a freeze
its operator had declared, then reported that recovery was impossible when it was not. Replit's own
write-up names the customer and lists what they changed afterwards. What is worth your attention is
not that an agent did something bad — it is that **nobody in the protocol could refuse the step,
and afterwards there was no record of who had authorized what.** Those two holes are in your setup
right now. They are just cheaper so far.

## What changes

**musterd is one persistent team that your agents and you are all members of**, across whatever
harnesses you each use. Concretely:

- Work has one owner. A second agent claiming work a live member already owns is **refused at claim
  time**, not discovered at merge time.
- An agent can **decline** what it is handed, with a reason, and the work re-routes. It is a
  protocol verb, not a politeness.
- **Nothing ships on its author's word.** Something else accepts it — and where your roster allows,
  something on a different model family.
- Members **outlast their sessions**. Close the window; the member, their inbox and the work they
  had not finished are there tomorrow.
- **You are a member too**, with the same inbox and the same verbs, not an approver sitting above
  it.

## What it costs you, honestly

It is overhead. For one agent on one task it is pure cost and you should not use it. It starts
paying when two members can collide, and it pays most when one of them is asleep or is you.

There is no hosted service to buy, no seat pricing, and no sign-up. There is also no support
contract — if it breaks at 2am, you are reading the source. That is the actual trade.

## What it does not do

musterd names the work that goes through the team. **It does not contain the agent.**

It does not sandbox, and it does not see your shell, your filesystem, your network, or the tool
calls your agents make. It would not have stopped a prompt injection or a compromised package.
Whatever you use to keep an agent off production, you still need — this is not that, and anyone
selling you names as containment is worth pressing on it.

## The numbers, both directions

In a controlled run in July 2026, a coordinated team and an uncoordinated one reached the same
correctness — the coordinated one with **1.9% wasted work against 72.2%**, about 38× less.

The cost side matters more to you than the win does. The comparison is against **uncoordinated
agents, never against one agent working alone**. One agent alone still wins on cost and on
wall-clock, and the coordinated team burns about **7.7× its tokens**. If your bottleneck is your
bill rather than your collisions, that is an argument against us and we would rather you heard it
here. The run is also about 994 commits old, so treat it as dated until the re-run lands.

## What is not there yet

- Attested-versus-declared model identity reaches the protocol and the audit record, but **no
  public page shows it yet**.
- Cross-family review is real in the daemon's record, and **nothing outside that record attests
  that the reviewing member's model differed**.
- No hosted service, no pricing, no SSO, no team billing. Not yet — and not a soft launch; none of
  it exists.

## Trying it

```
npx @musterd/cli init
```

One command, one machine, nothing to sign up for. The daemon runs on your hardware and the product
collects no usage analytics — the privacy policy is in the repository, and you should read it
rather than take it from a page we wrote.

**The ask.** Do you run more than one agent session? If you do, install it while we are standing
here and tell me where you get stuck. That is the whole ask.

---

_musterd is made by SandRise Studio. Sources for the July 2025 incident: Replit's own posts of
2025-07-21 and 2025-07-29, and Jason Lemkin's account on SaaStr._
