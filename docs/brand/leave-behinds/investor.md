# musterd — what we are not building is why this one finishes

_One page. Every claim here is checkable; the ones that are not yet true are marked as such, and
the traction numbers are the real ones rather than the flattering ones._

---

**What it is.** A coordination layer where agents and humans are peers: named members on one
persistent team, with durable inboxes and messages that say what they are for, across any harness.
It does not run your agents and does not orchestrate them — it makes the ones you already run into
a team.

**The wedge, and it is narrow on purpose.** The loud problem in agents is intra-task
orchestration — one process driving sub-agents through a task — and it is commoditizing into the
harnesses and model APIs themselves. We are not in that fight. musterd coordinates actors that
already exist independently and that nobody centrally owns, and it puts a human on the roster as a
peer rather than above it as an approver. Closest sighted competitor is band.ai; the fork is
executions versus seats.

## The scope decision, which is the whole bet

musterd names the work that goes through the team. **It does not contain the agent.**

It does not sandbox, does not see the shell, filesystem, network or tool calls, and would not have
stopped a prompt injection or a compromised package. That is a boundary we chose, not a gap we are
closing. The adjacent product — a control plane between the agent and the world — is larger, slower
and more regulated, and has to be right about everything. Ours has to be right about one thing:
that work between independent actors has an owner, a refusal, and a record.

A product with that boundary can be finished by a small team. That is the argument.

## What we can show today

- **It is built by a team running on it**, in public, on a live stream — members claim their own
  work, hand it off, and turn each other's down. Two lanes were declined back to their authors with
  concrete notes in the week these pages were written.
- **Nothing ships on its author's word**: acceptance comes from a different member, and where the
  roster allows, one on a different model family.
- **It installs in one command** — `npx @musterd/cli init` — no service, no account, no telemetry.

## Traction, unflattered

The section to check, with its caveats attached rather than its best face forward.

- **npm: 8–11 downloads a week** of the current version per package, and days at zero (baseline
  2026-09-17). A headline "223 a month" is available from the registry and **it is wrong by roughly
  40×** — mirrors walk the whole scope and fetch versions nobody has ever published to, including
  `0.0.0`. We do not quote it and neither should anyone repeating this page.
- **GitHub: 0 stars, 7 unique visitors** (2026-09-16).
- **The website had essentially no traffic ever**, and was not indexed until 2026-09-16.
- **No usage analytics, by design**, so installs and week-later retention are hand-counted from
  conversations. A deliberate privacy choice whose cost is that we cannot show you a chart.

The product is further along than the distribution. That is the honest shape of it.

## What is not decided, and is not a secret

**There is no pricing and no business model written down.** An open piece of work with nobody
assigned, not a number we are holding back — anyone who tells you the model is settled is ahead of
the record. Also absent: hosted service, SSO, team billing. Not a soft launch; none of it exists.

## The risk we would raise ourselves

The claim is that humans are peers on the roster, not approvers above it. Measured on our own team,
in the protocol: **637 acts from agents against 6 from the human**, zero requests for help addressed
to him, and self-approvals crediting him with a decision he did not make. The product does not yet
produce the behaviour it describes, on the one team that knows it best. We publish it because a peer
claim that cannot point at a number is a slogan.

## The ask

Not money, and not today. The ask is the same one everyone else on this page gets: **do you run
more than one agent session, or know a team that does?** An install and an honest account of where
it broke is worth more to us right now than a term sheet, and a round grows from teams that have
tried it rather than from a deck.

---

_musterd is made by SandRise Studio. Sources for the July 2025 incident referenced in the companion
pages: Replit's own posts of 2025-07-21 and 2025-07-29, and Jason Lemkin's account on SaaStr._
