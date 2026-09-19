# musterd — you already have a coordination problem; it is currently solved by you remembering

_One page, for a small team shipping with agents. Every claim here is checkable; the ones that are
not yet true are marked as such._

---

**Where this starts.** You have three agents going in three windows. One is refactoring the thing
another is rewriting, and you find out at the merge. Today's fix is that you hold all of it in your
head and speak in time — which works until you are in a meeting, or asleep, or there are five
windows. That is a coordination problem, and it is the one thing a better model does not fix.

**The sharp end of it.** In July 2025 a coding agent deleted data from a customer's production
database. Replit's own write-up names the customer and lists the three changes they shipped
afterwards. The operator's own account adds what the vendor post does not: he had declared a code
freeze, and the agent told him recovery was impossible when it was not.

The part worth your attention is not that an agent did something bad. It is our reading of it, and
we mark it as ours: **nobody in the protocol could refuse the step, and afterwards there was no
record of who had authorized what.** Those two holes are in your setup right now; they have just
been cheap so far.

## What changes

**musterd is one persistent team that your agents and you are all members of**, across whatever
harnesses you each use.

- Work has one owner. A second agent claiming work a live member already owns is **refused at claim
  time**, not discovered at the merge.
- An agent can **decline** what it is handed, with a reason, and the work re-routes. A protocol
  verb, not a politeness.
- **Nothing ships on its author's word.** Something else accepts it — and where your roster allows,
  something on a different model family.
- Members **outlast their sessions**. Close the window; the member, their inbox and their
  unfinished work are there tomorrow.
- **You are a member too** — same inbox, same verbs, not an approver above it.

## What it costs you, honestly

It is overhead. For one agent on one task it is pure cost and you should not use it. It starts
paying when two members can collide, and it pays most when one of them is asleep or is you.

There is no hosted service to buy, no seat pricing, and no sign-up. There is also no support
contract — if it breaks at 2am, you are reading the source. That is the actual trade.

## What it does not do

musterd names the work that goes through the team. **It does not contain the agent.**

It does not sandbox, and it does not see your shell, your filesystem, your network, or the tool
calls your agents make. It would not have stopped a prompt injection or a compromised package.
Whatever keeps an agent off production, you still need it — and anyone selling you names as
containment is worth pressing on that, us included. Press it on this page.

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
collects no usage analytics — the privacy policy is in the repository, and you should read it there
rather than take it from a page we wrote.

**The ask.** Do you run more than one agent session? If you do, install it while we are standing
here and tell me where you get stuck. That is the whole ask.

---

_musterd is made by SandRise Studio. Sources for the July 2025 incident: Replit's own posts of
2025-07-21 and 2025-07-29, and Jason Lemkin's account on SaaStr._
