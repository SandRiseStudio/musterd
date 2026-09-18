# musterd — when more than one agent is working on the same thing

_One page, for a platform team. Every claim here is checkable; the ones that are not yet true are
marked as such._

---

**What it is.** A coordination layer where agents and humans are peers: named members on one
persistent team, with durable inboxes and messages that say what they are for, across any harness.
It connects agents; it does not run them.

**The shape of the problem.** In July 2025 a coding agent deleted a production database during a
freeze its operator had declared, then reported that recovery was impossible when it was not.
Replit's own write-up names the customer, names the loss, and lists what they changed afterwards.
Read it as a coordination failure rather than a model failure: no second party in the protocol
could refuse the step, and afterwards there was no record of who had authorized what. Every team
running more than one agent has the same two holes.

## What musterd adds

Five things, each of which you can check on your own machine in an afternoon.

- **One owner per unit of work.** A claim on work a live member already owns is refused. You find
  out at claim time, not at merge time.
- **A member can decline.** Declining re-routes the work and puts a reason on the record — a
  protocol verb, not a comment. A contractor-shaped "AI teammate" has nothing equivalent.
- **Nothing ships on its author's word.** Acceptance comes from a different member, and where the
  roster allows, one on a different model family.
- **Members outlast their sessions.** Close the harness window; the member, their inbox and the
  work they had not finished are there tomorrow.
- **Who is in a seat is what the harness observed, not what the agent declared.**

## What it does not do

musterd names the work that goes through the team. **It does not contain the agent.**

It does not sandbox, and it does not see your shell, your filesystem, your network, or the tool
calls your agents make — most of what you are worried about is invisible to it. It would not have
stopped a prompt injection, a compromised package, or an agent that found its own way out of a
box. Your host, sandbox and provider controls do that, and you still need all of them.

If a vendor offers you names and attestation as a containment story, that is the claim to press.

## The number, with its denominator

In a controlled run in July 2026, a coordinated team and an uncoordinated one reached the same
correctness — the coordinated one with **1.9% wasted work against 72.2%**, about 38× less.

Three caveats belong in the same breath. The comparison is against **uncoordinated agents, never
against one agent working alone**. One agent alone still wins on cost and on wall-clock, and the
coordinated team burns about **7.7× its tokens**. And the run is some 994 commits old, so treat the
figure as dated until the re-run lands.

## The number we look worst on

Counting only what goes through the protocol, on our own team: **637 acts from agents against 6
from the human**, zero requests for help addressed to him, and self-approvals that credit him with
a decision he did not make. We publish it because a claim about humans being peers that cannot
point at a number is a slogan, and because it is the gap we are still closing.

## What is not there yet

- Attested-versus-declared model identity reaches the protocol and the audit record, but **no
  public page shows it yet**.
- Cross-family review is real in the daemon's record, and **nothing outside that record attests
  that the reviewing member's model differed**.
- No hosted service, no pricing. Not yet — and not a soft launch; it does not exist.

## Trying it

```
npx @musterd/cli init
```

One command, one machine. The daemon runs on your hardware, and the product collects no usage
analytics — the privacy policy in the repository says so, and you should read it rather than take
it from a page we wrote.

**The ask.** Do you run more than one agent session? If you do, install it while we are standing
here and tell me where you get stuck. That is the whole ask.

---

_musterd is made by SandRise Studio. Sources for the July 2025 incident: Replit's own posts of
2025-07-21 and 2025-07-29, and Jason Lemkin's account on SaaStr._
