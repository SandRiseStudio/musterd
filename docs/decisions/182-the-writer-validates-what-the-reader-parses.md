# 182 — the writer validates what the reader parses

- Status: accepted
- Date: 2026-07-29

## Context

`binding.json` is the workspace's identity: which server, which team, which seat, plus the
hook-written `session` capture and `model_observed` attestation. Two packages read and write it —
`packages/cli/src/config.ts` and `packages/mcp/src/binding.ts` — with near-identical code, and
`BindingSchema` lives in `packages/protocol` precisely so "the two readers can't drift on shape".

The readers had never drifted. The **writers** had never been asked to agree with them at all.

Both `readBinding` implementations run `BindingSchema.parse` inside a `try/catch` that returns
`null`. Both `saveBinding` implementations wrote whatever they were handed: merge-guard, tmp file,
`rename`, no parse.

On 2026-07-29 that asymmetry cost a seat its identity for a full session. The tool-boundary slot heal
([#503](https://github.com/SandRiseStudio/musterd/pull/503)) set `session.started_at` from
`statSync(path).birthtimeMs`, which is **fractional**, while `SessionCaptureSchema.started_at` is
`z.number().int()`. One heal wrote `1785352706039.4507`, and from that moment `findBinding` returned
`null` for that workspace permanently
([#508](https://github.com/SandRiseStudio/musterd/pull/508)).

Two properties made it expensive to find:

1. **The seat kept working.** The MCP adapter holds its resolved identity in memory, so `team_*`
   calls were fine. Only the CLI paths — which re-resolve per invocation — died.
2. **`null` is overloaded.** It means both "no binding here" and "a binding I could not parse", so
   the workspace read as *unbound* rather than *broken*. `refreshModelObservation` bailed at its
   first guard on every tool boundary, silently, which is why a model misattestation fixed in
   [#506](https://github.com/SandRiseStudio/musterd/pull/506) did not self-correct even once the fix
   was live.

## Problem

The specific bug is a one-line fix. The shape of it is not, and it will recur.

TypeScript cannot see the difference between the schema and the type it produces. Every Zod
refinement — `.int()`, `.min()`, `.regex()`, `.url()`, every brand — is a runtime narrowing on a
field the compiler only knows as `number` or `string`. A caller that fully satisfies `Binding` can
therefore write a file that no reader will accept, and neither `tsc` nor review will say a word.
`started_at` was simply the first refinement a writer happened to violate.

The consequence is unusually severe for a config file, because the failure is not "this write is
lost". It is "the previous, working identity is destroyed and cannot be recovered without hand
editing", and the workspace reports itself as merely unbound while that is true.

Because `BindingSchema` is a published contract, this is not only our problem: any other
implementation that writes a musterd binding inherits exactly the same trap.

## Decision

**A writer must validate against the same schema its readers parse, and must refuse the write
rather than complete it.**

`packages/protocol` gains `assertWritableBinding(binding: unknown): void`, which runs
`BindingSchema.safeParse` and throws with the failing paths. It lives beside the schema, not inside
either `saveBinding`, so the two write paths cannot drift on what counts as writable — the same
reasoning that put the schema there for the readers.

Both `saveBinding` implementations call it **before the tmp write**, so a refusal leaves no debris.

Throwing is the deliberate half of the trade. Completing an unreadable write is not "no worse than
nothing": it replaces a working identity with one that no reader accepts. A refused write leaves the
previous good binding byte-identical on disk, and the next capture heals it. On the one hook path
not already wrapped in a `try/catch` (`captureSession`), the hook one-liner ends in `|| true` and a
lost capture self-heals at the next tool boundary — a written brick does not.

Second, **`readBinding` distinguishes absent from corrupt.** A file that fails to open returns
`null` as before. A file that opens but does not parse also returns `null` — the callers are
unchanged — but first announces itself on stderr, once per path. Warn-once because this read rides
the PostToolUse hook; stderr because the MCP protocol channel is stdout.

### Scope

This ADR governs `binding.json` and adds no schema, field, or wire change — `assertWritableBinding`
validates the existing contract and does not alter it. The principle generalises to any
schema-validated file musterd persists, but no other writer is changed here.

## Consequences

- A bad write now fails loudly at the writer instead of silently at every later reader. Callers that
  build a binding from untrusted or computed values must be prepared for a throw; the fourteen
  in-tree call sites either sit inside an existing `try/catch` (the hook paths) or are user-facing
  commands where a visible error is the correct outcome.
- The class of bug closed is broader than the instance: any future refinement violation is caught at
  the moment of the write, by the same schema the reader will apply.
- A corrupt binding stops being invisible. The operator gets a sentence naming the file and the
  failing field instead of a workspace that quietly behaves as if it had no seat.
- The guard is duplicated in behaviour across CLI and adapter but defined once, so a future edit to
  one surface cannot silently weaken the other. Both surfaces are pinned by their own test.
- This does not repair bindings already corrupted. Detection is now loud, but the repair is manual.

## Observability & Evaluation

**Traces** — a refused write surfaces as a thrown error naming the failing schema paths, at the
writer's own call site rather than at some later reader. A corrupt file surfaces as a one-per-path
stderr line naming the file and the parse failure. Before this ADR neither event produced any signal
at all: the count of both was structurally unobservable, which is the thing being fixed.

**Eval** — the regression cases are concrete and cheap, one per surface: hand `saveBinding` a
type-correct binding with a fractional `started_at` and assert it throws, that the previous file is
byte-identical afterwards, and that no tmp file is left behind. Baseline: on the parent commit both
surfaces accept that write and the resulting file fails `BindingSchema.safeParse` — which is the
measured 2026-07-29 incident, replayed.

The standing check that this keeps working is the sweep already used to bound the incident: parse
every `agents*/.musterd/binding.json` with `BindingSchema` and expect all of them valid. It ran at 1
invalid of 12 during the incident and 12 of 12 valid after repair.

**Experiment** — none. There is no hypothesis to test: the reader's schema is the definition of a
readable binding, so a writer disagreeing with it is a defect rather than a tuning choice. The open
question this ADR does *not* answer is whether `saveBinding` should also write the parsed (and thus
unknown-key-stripped) object rather than the original; it deliberately writes the original, so that
validation cannot silently drop a field a newer writer added.
