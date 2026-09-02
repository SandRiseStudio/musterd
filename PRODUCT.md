# Product

## Register

product

## Users

Engineers and operators running **musterd** — the coordination layer where agents and humans are
peers: named members on one persistent roster, with durable inboxes and typed acts, across any
harness (ADR 320). It connects agents; it does not run them.

The user is a **member**, not an audience. They act through their own seat — claiming lanes,
declining handoffs, answering asks, holding another member to acceptance — from a CLI, a harness
session, or the web. A member can also be present on more than one machine, and a team's roster
spans every node it federates with (ADRs 355–360).

The primary surface in focus is the **live-comms dashboard** (`/live`): where a member watches all
of a team's communication in real time. Watching is one posture among several, not the user's
station — they're glancing at a wall, scanning for a `request_help`, or watching a coordination arc
resolve, and then answering it from their seat. Often left open on a second monitor.

## Product Purpose

Make coordination between separate actors (agents + humans) **visible and felt** in real time. The
dashboard streams every act on a team — the firehose — as a legible feed plus an ambient office scene
of who's working with whom. Success: a glance tells you the team's state; a `resolve` landing feels good;
you trust it enough to leave it running.

What the surface must never imply: that the humans on screen are the operators above the agents.
The console category's grammar forbids musterd's headline claim (ADR 320 §1), and the dashboard is
the surface most able to reintroduce it by accident — a human rendered as a supervisor of the room
rather than a member in it contradicts the position the rest of the product is built on.

## Brand Personality

Precise, calm, alive. The voice is plain and declarative (never hype); the _experience_ carries the
spectacle. Three words: **engineered, luminous, quiet-confident.** It should feel like a premium
instrument — a telescope, not a toy.

## Anti-references

- SaaS-dashboard cliché: gradient hero-metrics, identical icon+label card grids, purple-blue gradients.
- Chat-app skins: bubble-and-avatar messenger UI. This is a _stream_, not a chat.
- Over-animated "fun" dashboards: confetti, bounce/elastic easing, motion as decoration.
- Glassmorphism-everywhere. Heavy neon cyberpunk. Anything that reads "AI made this dashboard."
- Fleet console: an operator pane above a worker grid, agents as inventory with utilization meters.
  Structurally the wrong category, not just the wrong skin (ADR 320 §1).

## Design Principles

1. **Quiet frame, living contents.** The chrome and stream are calm and precise (the discipline of a
   premium tool, but **warm** — candlelit, not cool blue-gray); the spectacle concentrates in the
   office scene, which is _alive_ (presence, motion, depth). The one product surface where
   coordination IS the product, so it earns selective spectacle.
2. **Calm at rest, energetic in motion.** The canvas is near-still so each message lands as an event;
   energy is front-loaded into the first ~400ms of a message's life, then it settles.
3. **The act is the unit.** Communication (acts, arcs, the resolve payoff) is always the brightest,
   most-alive thing on screen; everything else recedes.
4. **Earned familiarity.** Standard affordances, every interaction state present, the tool disappears
   into the task. Delight in moments, not on every pixel.
5. **Honest motion.** Acts arrive whole and atomic — animate _arrival_ and _relationship_, never fake
   token-streaming. Motion conveys state.
6. **Members render alike.** A human and an agent are drawn by the same rules — same roster row, same
   bubble, same acts. Where the two must differ, the difference states which harness or which person
   is behind the seat; it never ranks one above the other.

## Accessibility & Inclusion

WCAG AA: body text ≥ 4.5:1 (light-on-near-black, comfortably met), focus-visible rings on every
control, full keyboard path. `prefers-reduced-motion` drops all ambient/continuous motion (breathing,
pulses, parallax, typewriter) to a calm static view. Act meaning never relies on color alone — the act
name is always written.
