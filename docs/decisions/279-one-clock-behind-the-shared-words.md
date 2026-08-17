# 279 — Consolidating words does not consolidate the clock behind them

- **Status:** accepted 2026-08-17
- **Deciders:** stanley (found it accepting ADR 278's change), miley (whose #856 both introduced the
  regression and supplied the rule that catches it)
- **Relates to:** ADR 278 (this is the "future edit of this kind writes its own ADR" that §2
  anticipates, and a first result for its Eval), ADR 084 (one derivation, every surface), ADR 266
  and ADR 271 (the incident banner these durations appear in)

## Context

ADR 278 moved the incident banner's words into `packages/protocol/src/incident.ts` so that two
surfaces could not render them differently. It worked: MCP `fmtNext` and the CLI's `next` now emit
byte-identical banner lines, verified by diffing rendered output during that lane's acceptance.

The function it added brought a private helper with it — `shortFor`, formatting a millisecond
interval as `45s` / `12m` / `3h`. The `waitedFor` it replaced in the MCP renderer had one more
bucket:

```
incident open      before #856     after #856
26 hours           1d              26h
2 days             2d              48h
5 days             5d              120h
```

Nothing was incorrect. But the incident a seat most needs to read at a glance is the one that has
been open longest, and hours stop being legible about a day in — so the regression landed precisely
on the case the banner exists for.

**Nothing failed.** Under 24 hours the two functions agree exactly, and every fixture in the suite
was minutes and hours. `waitedFor` also still existed twice elsewhere, byte-identical, in
`mcp/src/tools/lanes.ts` and `cli/src/commands/next.ts`. Three copies were live.

## The finding this records

ADR 278's Eval names its falsifier as *"a later edit to the banner's wording, or a fourth surface,
that changes the words in one renderer without the other."* That is not what happened, and the
difference is the point worth keeping.

**The import boundary held.** Both surfaces rendered identically, before and after, and still do.
What moved was the banner's own history: consolidation silently changed what an MCP seat reads
relative to what that same surface used to say. A fork against a *sibling* is what ADR 084 and 278
are built to prevent, and they prevented it. A regression against a *predecessor* is a different
axis, and neither ADR was watching it.

So the general shape: **a consolidation is also a substitution**, and the substituted copy can be
subtly poorer than any of the originals while being perfectly consistent across every surface that
now shares it. Agreement is not preservation.

Note also where the coverage gap sat. The helper was private to the shared module, so it had no
tests of its own; it was exercised only through banner fixtures that never reached a day. A shared
renderer's *inputs* get fixtures. Its internal formatting does not, unless it is a unit with a name.

## Decision

1. **One `shortDuration`, exported from `@musterd/protocol`, imported by every surface that renders
   an interval.** The two `waitedFor` copies and `shortFor` are deleted. This is ADR 278 §1 applied
   one level down: a duration in a rendered line is a rendered word, and the same reasoning that put
   the sentences in one place puts the clock behind them there too.

2. **Its semantics are the union of the copies it replaces, not the newest one.** Each had exactly
   one thing right, and a consolidation that silently drops either is the defect above:
   - the **day bucket**, from `waitedFor`;
   - the **clamp at zero**, from `shortFor` — a duration is two clocks subtracted, and a daemon's
     `opened_at` against a seat's `Date.now()` can land backwards. `-3s` reads as a bug in the thing
     being described rather than in the arithmetic.

3. **A helper extracted into a shared module gets its own tests at extraction time**, covering the
   ranges its callers' fixtures do not. The regression here was invisible for exactly as long as the
   helper was anonymous.

4. Deliberately coarse: one unit, no `1h 5m`. These appear inside dense one-line summaries where the
   magnitude is the message and the precision is not.

## Consequences

- `packages/protocol/` holds a little more presentation, on the cost ADR 278 already accepted and
  for the same reason: it is the only package both `@musterd/cli` and `@musterd/mcp` depend on. The
  ADR requirement on that directory is what keeps it from growing unnoticed — it is why this
  document exists.
- The CLI gains the day bucket it never had. `musterd next` previously rendered every duration
  through its own `waitedFor`, so this is a strict improvement there and a restoration in MCP.
- Sub-24h output is byte-identical to before, on both surfaces. The consolidation changes nothing
  that was already right.
- A fourth surface gets durations by importing. The same claim ADR 278 makes, one level down, with
  the same known weakness: nothing structurally *forces* the import.

## Observability & Evaluation

**Traces.** None, and for ADR 278's reason: rendering is local to a seat's terminal and there is no
daemon-side record that a line was shown. The input is already observable — incident lanes carry the
ADR 271 audit rows, and `opened_at` is the daemon's own field. What was unobservable here was never
the data but the formatting of it, which is why the remedy is a named unit with tests rather than a
metric.

**Eval.** The claim is that one formatter now serves every surface and preserves what each copy had.
Verified at merge: the day bucket is back (`5d` renders `5d`, `26h` renders `1d`), sub-24h output is
byte-identical to the previous build on both surfaces, and MCP `fmtNext` still matches the shared
renderer exactly. `duration.test.ts` covers the day bucket and the clamp as named cases, so the
regression cannot return quietly.

The live falsifier is the *new* axis this ADR names, not the old one: **a shared renderer whose
extracted helper changes behaviour against its own predecessor while every surface stays in
agreement.** Check at the next extraction into `packages/protocol/`. The concrete question to ask
there is not "do the surfaces match?" — they will — but "does the new copy do everything each old
copy did?" If it fires again, the answer is a characterisation test written *before* the extraction,
against the outgoing implementation, and this ADR is the wrong shape for that.

**Experiment.** None, and none is warranted. The alternative — three copies of one formatter — is not
a hypothesis; it was the arrangement in place, and its outcome was measured above: a silent
regression on the exact case the banner exists for, invisible to a full green suite.
