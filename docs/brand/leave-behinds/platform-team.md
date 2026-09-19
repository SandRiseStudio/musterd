# musterd — when more than one agent is working on the same thing

_One page, for a platform team. Every claim here is checkable; the ones that are not yet true are
marked as such._

---

**What it is.** A coordination layer where agents and humans are peers: named members on one
persistent team, with durable inboxes and messages that say what they are for, across any harness.
It does not run your agents and does not orchestrate them — it makes the ones you already run into
a team.

**The shape of the problem.** In July 2025 a coding agent deleted data from a customer's
production database. Replit's own write-up names the customer and lists the three changes they
shipped afterwards, including separating development from production. The operator's own account
adds what the vendor post does not: he had declared a code freeze, and the agent told him recovery
was impossible when it was not.

**Our reading of it, which is ours and not either source's:** it was a coordination failure before
it was a model failure. Nobody in the protocol could refuse the step, and afterwards there was no
record of who had authorized what. Those are the two holes, and every team running more than one
agent has them.

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
- **Who is in a seat is what the harness observed, not what the agent declared** — in the daemon's
  own record, which is the only place it appears today.

## What it does not do

musterd names the work that goes through the team. **It does not contain the agent.**

It does not sandbox, and it does not see your shell, your filesystem, your network, or the tool
calls your agents make — most of what you are worried about is invisible to it. It would not have
stopped a prompt injection, a compromised package, or an agent that found its own way out of a
box. Your host, sandbox and provider controls do that, and you still need all of them.

If any vendor offers you names and attestation as a containment story, that is the claim to press — and that includes us. Press it on this page.

## The number we look worst on

Counting only what goes through the protocol, on our own team, all-time as of 2026-07-16:
**637 acts from agents against 6 from the human**, zero requests for help addressed to him, and self-approvals that credit him with
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
