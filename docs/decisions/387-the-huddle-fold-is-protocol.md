# 387 — What a huddle IS belongs to the protocol; what a surface DRAWS does not

- Status: proposed
- Date: 2026-09-04
- Builds on: [ADR 378](378-a-huddle-is-a-thread.md) (a huddle is a thread; the room is a view over the log), [ADR 144](144-mcp-tool-surface-measure-then-craft.md) (the tool list is a budget, not a catalogue), [ADR 103](103-steer-challenge-defer-acts.md) (additive meta, no wire-version bump)
- Lane: 01M1PYNK0K

## Context

ADR 378 shipped the huddle fold — `deriveHuddles` / `huddleTopics`, which turn an envelope timeline
into the rooms it contains — as `packages/cli/src/render/huddles.ts`, with a comment saying it was
"deliberately pure and CLI-local… a rendering concern, not a wire contract, so it does not belong in
`@musterd/protocol` — the web surface will want its own, shaped by what it draws."

That was half right, and the lane that built the MCP room read (increment 3) is where the other half
came due. A second reader appeared: an agent is told, at its inbox, that a turn belongs to a room.

## Decision

**The fold moves to `packages/protocol/src/huddleView.ts`. Rendering stays with each surface.**

The line is not "pure functions go in protocol". It is narrower and it is about who must agree:

- **What a huddle IS** — which rows belong to it, who is named in it, who has spoken, whether it is
  closed, where its anchor landed — is a **reading of the wire**. It is derived from `meta.huddle`,
  `thread` and `meta.anchor_ref`, which ADR 378 put on the wire precisely so that anyone could read
  them. Two surfaces that answer those questions differently do not disagree about presentation;
  they disagree about *what happened*, and the same room becomes two different rooms.
- **What a surface DRAWS** — colour, `ago()`, the summary line, the CLI's box, the MCP room block's
  byte budget, the web's avatars — is genuinely local, and the original comment is right about it.

So the original reasoning was sound about the second half and mistaken about the first. `HuddleMeta`
was already in `packages/protocol/src/huddle.ts`; the fold now sits beside the schema it folds.

**This adds no wire field, no act, no version bump.** It is a derived read of shapes ADR 378 already
defined — the same category as `eligibleOf` and `envelopePosition`, which live there for the same
reason.

## Consequences

- One definition of "who is in this room" for the CLI and the MCP surface, and for any later reader
  that folds the same rows. A drift bug of the shape "the CLI says jo is in it and the agent's inbox
  says jo is not" is now unrepresentable.
- `packages/protocol` gains a module that is a *derivation*, not a schema. That is a widening of what
  the package holds and it should not be taken as licence: the test is whether independent readers
  must agree on the answer, not whether the function happens to be pure.
- An external implementation of the protocol now has a reference fold to match, rather than having
  to reconstruct one from the CLI's renderer.

## Observability & Evaluation

- **Traces:** none new. This moves a pure function between packages; it reads no new field, writes
  nothing, and issues no query.
- **Eval:** the falsifier is agreement between surfaces. `musterd huddle show <id>` and the room
  block that `team_inbox_check` renders for the same huddle must name the same participants, the
  same turn count, and the same open/closed state. Falsifier: any huddle for which the two disagree
  — which, with one shared fold, can only be caused by the two surfaces reading different windows of
  the log, and that is itself worth knowing.
- **Experiment:** n/a — a placement decision. The alternative (two copies of the fold) is the thing
  this exists to prevent, and running both concurrently to compare would be building the defect on
  purpose.
