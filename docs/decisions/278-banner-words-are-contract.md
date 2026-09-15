# 278 — Rendered words that cross a surface boundary are protocol

- **Status:** accepted 2026-08-17
- **Relates to:** ADR 084 (one derivation, every surface — this extends it from the derivation to
  the renderer), ADR 266 and ADR 271 (incident convergence increments 1 and 2, which shipped the
  banner this ADR is about), ADR 259 (a fact the team learned is a wiki page; a choice it made is
  an ADR).

## Context

`packages/protocol/src/` carries a hard rule: an edit there needs an ADR, because other
implementations depend on the wire contract and changing it silently is how a protocol forks
(`scripts/check-change-adr.ts`, rule 1). The rule is path-based and does not ask what kind of edit
it is looking at.

This change adds no schema. It adds `incidentBannerLines()` — a pure function from one
`NextBrief.incidents` entry to plain lines, no colour, callers own their theming — and moves the
banner's wording out of the MCP renderer so the CLI can import it instead of re-deriving it.

The reason it is in `packages/protocol/src/` at all is that this is the only package both
`@musterd/cli` and `@musterd/mcp` depend on. `@musterd/telemetry` is the sole other shared
dependency and is the wrong domain. There is no neutral "shared presentation" home, and inventing
one for a single function would be worse than the thing it avoided.

So the gate's own escape hatch — "move the edit out of `packages/protocol/src/` if it is not
contract-facing" — does not apply here, and not merely for want of somewhere to put it. The words
**are** contract-facing, which is the whole finding of the change that carries them.

## The finding this records

ADR 084 is usually read as being about derivation, and the derivation was correctly shared all
along: `deriveNext` is server-side, single-copy, and both surfaces receive the same
`brief.incidents`. What drifted was the **renderer**. Increments 1 and 2 put the banner only in the
MCP renderer, so every CLI seat running `musterd next` got no banner at all — through two whole
increments, on the surface where a session *starts*, for the feature ADR 266 calls "the cheapest,
highest-leverage piece" precisely because the measured waste was seats starting work into a shared
red they assumed was theirs.

Nothing could notice. A missing section throws no error and fails no test. A second renderer that
silently lacks a section is invisible in exactly the way a forked schema is not.

## Decision

1. **A shared-derivation rule (ADR 084) covers the rendering of that derivation too**, wherever the
   same brief reaches more than one surface. One copy of the words, imported.

2. **`packages/protocol/` is where those words live**, and an edit adding them is a legitimate
   protocol change rather than a gate to be routed around. Rule 1's ADR requirement is satisfied by
   recording the change, which is what this document is; the requirement is not weakened, and no
   exemption for "non-schema" protocol files is created. A future edit of this kind writes its own
   ADR.

3. **The contract of such a function is: plain strings, no colour, no surface assumptions.** Themeing
   and placement stay with the caller, because they are the parts that legitimately differ.

## Consequences

- A third surface gets the incident banner by importing rather than by remembering.
- `packages/protocol/` now holds a small amount of presentation. This is a real cost: the package's
  name promises wire contract, and a reader will find words there. Accepted, because the measured
  alternative failed silently for two increments, and because the ADR requirement on that directory
  means it cannot grow unnoticed.
- The CLI test asserts **placement**, not just presence: the banner must precede the seat's own
  work, or the seat decides what it is doing before learning the red is shared.

## Observability & Evaluation

**Traces:** none, and the absence is the point rather than an oversight. Rendering is local to a
seat's terminal; there is no daemon-side record that a banner was *shown*, and adding one would mean
instrumenting every `musterd next` for a display event nobody would read. What is already observable
is the input — `brief.incidents` is derived server-side by `deriveNext`, and incident lanes carry the
audit rows ADR 271 gave them. The gap this ADR closes was never visible in traces and never could
have been: a renderer that omits a section emits nothing at all. That is why the remedy is an import
boundary and a test, not a metric.

**Eval:** the falsifier is a later edit to the banner's wording, or a fourth surface, that changes
the words in one renderer without the other. Check at the next incident-banner change, and whenever
a new surface starts consuming `NextBrief`. If it fires, the import boundary did not hold, and the
answer is a test both surfaces read from — not a third copy, and not this ADR restated.

**Experiment:** not run, and none is warranted. The competing arrangement — the words duplicated per
surface — is not a hypothesis; it is the arrangement that was in place through increments 1 and 2,
and its outcome was measured: zero CLI seats saw a banner, on the surface where sessions start. A
single shared copy is adopted on that evidence. What remains genuinely open, and is *not* settled by
this change, is whether the per-case remedy generalises: if the next cross-surface gap is again a
section one renderer lacks entirely, the reachable check is structural — every `NextBrief` section
referenced by every renderer — and this ADR is the wrong shape for it. Re-read here at that point.
