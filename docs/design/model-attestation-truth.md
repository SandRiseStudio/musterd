# Model attestation truth — observed over declared

Status: shipped as [ADR 158](../decisions/158-model-attestation-truth.md) — 2026-07-24. This document
is the design record; §6 was narrowed during implementation (the adapter-path rule became a note, and
the secret check moved to the inspection path) — see ADR 158 §6 for why.
Date: 2026-07-24
Author: ryder (seat), with nick

## 1. The incident

Seat `ryder` reported `grok-4.5` on the roster for weeks while the session was in fact running
`claude-opus-4-8` under Claude Code. Every obvious repair failed, each for a different reason:

- Editing `.musterd/binding.json` — overwritten. `saveBinding` rebuilds the binding from **boot-time
  config**, so the live adapter's next autojoin wrote the stale value straight back over the edit.
- `team_send` with `meta.model` — ignored. Attestation is per-occupancy, not per-message.
- `MUSTERD_MODEL=… musterd send` from the shell — no effect on the roster. An ambient HTTP touch
  re-attests only the _ambient_ presence row (`conn_id IS NULL`); the roster was rendering the
  connected MCP occupancy.

The actual cause was one line in the harness MCP entry:

```
MUSTERD_MODEL=grok-4.5    # baked at wire time, top of the precedence ladder
```

## 2. Root cause: a precedence inversion

The ladder is `env > binding.json > workspace.json` (`packages/mcp/src/config.ts`), and provisioning
writes a wire-time snapshot into `env` — the **top** rung. A guess therefore outranks every later
observation, and nothing downstream can correct it.

`packages/cli/src/onboard/mcpEntry.ts` already contains the argument against this, written about a
different field. Its comment explains why `MUSTERD_CLAIM` is deliberately _not_ baked: doing so froze
"a _copy_ that outranks binding.json and can never be updated by a re-claim." Eight lines later the
same function bakes `MUSTERD_MODEL` in exactly that shape. The principle was known and applied
inconsistently; model is the field that escaped it.

Model is in fact the _worse_ field to snapshot. A claim only changes when musterd acts (`musterd
claim`), so a stale copy is at least explicable. A model changes when the **harness** changes, with
no musterd action at all — so a snapshot begins rotting the moment it is written.

### 2.1 Why the existing tripwire did not catch it

The harness attestation tripwire (#273) classifies declarations as `environment` / `binding` /
`unknown` and warns on `unknown`. It detects _absent_ attestation only. A confidently wrong
declaration is indistinguishable from a correct one to it, so this failure passed silently — the
mode most damaging to ADR 056 diversity conclusions, since a wrong value poisons a chain while
looking healthy.

## 3. Constraints

- **A (hard): never attest a wrong model.** `unknown` is preferable to a lie. Diversity and
  decorrelation research depends on the value being trustworthy or honestly absent.
- **B: the failure must not require a manual hunt.** A wrong value self-corrects, or musterd names
  the exact knob that lies.
- **Even contract across harnesses.** Every harness gets the same slot, precedence, tripwire, and
  degradation. Fidelity behind the slot may differ — that is a property of the harnesses, not of
  musterd's guarantees.
- A hook must never fail (inherited from `musterd session`, ADR 131 §5).
- Warn-never-block stays the norm; §6 documents the single deliberate exception.

## 4. Design

### 4.1 Two tiers, by kind of claim

| tier        | source                                | meaning                                          |
| ----------- | ------------------------------------- | ------------------------------------------------ |
| 1. observed | harness probe (`observeModel()`)      | what the harness _is_ running, seen this session |
| 2. declared | `MUSTERD_MODEL`, then `binding.model` | what a human or config _says_ it runs            |
| 3. unknown  | nothing                               | honest absence — legal, never blocks             |

Observation beats declaration, newest-wins — the rule ADR 131 §6 already uses for provenance.
`MUSTERD_MODEL` survives only as a deliberate manual override for headless/CI, exactly as
`MUSTERD_CLAIM` does today.

### 4.2 Components

- **`observeModel(payload) → string | undefined`** — one slot on the existing harness adapter
  contract, implemented beside `claudeCode.ts` / `codex.ts` / `cursor.ts`. Never throws; any failure
  is `undefined`.
  - `claude-code`: reads `message.model` from the tail of the `transcript_path` the hook payload
    already carries. (The harness spawns the hook and hands it this path; a seat reads only its own
    session's record.) Verified to yield `claude-opus-4-8`.
  - `codex`: rollout-log model; a `musterd host`-spawned Codex seat is authoritative from the spawn
    arguments without parsing anything.
  - `cursor`: `undefined` for now — a declared, visible gap rather than a silent one.
- **`transcript-model.ts`** — the only module that knows any harness's on-disk format. The _path_ is
  a documented hook input; the _format_ is not, so it is isolated here and any parse failure
  degrades to `undefined`.
- **Observation write path** — the SessionStart hook already pipes `{session_id, transcript_path,
cwd}` into `musterd session start --stdin`, which writes `binding.session` under a merge guard.
  The observed model rides that same seam into a **separate** field, `binding.model_observed`.
- **Re-attestation** — the adapter resolves `observed > declared > unknown` and re-attests
  newest-wins on its next tool call, through the existing claim-frame / `x-musterd-model` paths. A
  wrong value therefore self-heals within one tool call.
- **Tripwire (extends #273)** — gains one case: `observed ≠ declared`. Fires on the roster and in
  `musterd init --check`, naming which knob is stale and where it lives.

### 4.3 Why `model_observed` is a separate field

The tripwire alone does not settle this. `declared` has two sources, so if an observation overwrote
`binding.model`, the `observed ≠ env` comparison would survive — the exact bug in §1 (a stale value
baked into the MCP entry) would still be caught. Three sharper reasons decide it:

1. **Observations would self-launder into declarations.** Session 1 observes `claude-opus-4-8` and
   writes it to `binding.model`. Session 2 boots, observes nothing (transcript not yet written, or a
   harness with no probe), and reads that value as a _declaration_ — though it is really the previous
   session's observation wearing a declaration's clothes. The field's epistemic status becomes
   unknowable, which is precisely the question we could not answer about `grok-4.5`, recreated one
   level down.
2. **It would destroy the rot metric.** §8 makes the `observed ≠ declared` rate the health signal for
   how often provisioning snapshots rot. If observations overwrite declarations, every mismatch is
   silently repaired _in the record_ the instant it is detected: the roster reads correct, and the
   evidence that a knob was stale is gone. Trend-to-zero becomes unmeasurable.
3. **It would put three writer semantics in one slot.** `saveBinding`'s merge guard exists because
   two writers clobbering one field caused the ADR 101 model-wipe. A single field would add a third
   — human declaration, hook observation, adapter rebuild — behind a guard built for two.

Against that, a single field buys one less key in a 0600 local file. It buys no consumer
simplification: the resolver must distinguish the tiers regardless, so both values exist in memory
either way. The only question is whether the file preserves the distinction or destroys it at rest.

This also matches house style. ADR 135 keeps build attestation (`x-musterd-build`) in its own field
rather than merging it into "things the client claims about itself," and `binding.session` got its own
field for the same reason: different writers, different lifecycles, different trust.

## 5. Data flow

```
harness starts session
  └─ SessionStart hook → musterd session start --stdin
       └─ observeModel(payload) → "claude-opus-4-8"
            └─ saveBinding(merge-guarded) → binding.model_observed
adapter's next tool call
  └─ resolve observed > declared > unknown
       └─ attest (claim frame / x-musterd-model)
            └─ roster shows truth; occupancy.model_attested audits old → new
```

### 5.1 Failure modes — degrade, never break

| failure                                   | behavior                                                         |
| ----------------------------------------- | ---------------------------------------------------------------- |
| no `transcript_path` in payload           | `undefined` → declared tier → unchanged from today               |
| transcript missing, unreadable, mid-write | `undefined`, hook exits 0                                        |
| format changed (no `message.model`)       | `undefined` + tripwire `unknown` — auto-downgrade to unbake-only |
| observed ≠ declared                       | attest **observed**, fire tripwire naming the stale knob         |
| daemon unreachable                        | binding still written; attested on the next successful touch     |
| human seat                                | unchanged — ADR 121 already ignores model attestation for humans |

Every path exits 0. A hook must never fail.

## 6. Increment 2 — provisioning identity guard

`resolveMcpLaunch()` resolves the adapter path from **the provisioning process's own location**
(`import.meta.resolve`, with a relative dev fallback). Provisioning ryder's folder by running
miley's CLI therefore wires ryder to launch miley's adapter permanently. Found in the wild:

```
Args: /Users/nick/agents-miley/packages/mcp/dist/index.js   # in ryder's folder
MUSTERD_GRANT=msgr_-WD649…                                  # from a different provisioning run
```

This is what planted `grok-4.5` in this seat. Fixing only the ladder leaves the planting mechanism
intact — the next bad provisioning run writes a fresh wrong value and we rely on the tripwire to
catch it rather than preventing it.

**Guard, at entry-write time.** An entry for workspace W must satisfy:

1. its adapter path lies inside W or a shared/global install — never inside a sibling seat's
   worktree; and
2. its `agent_key` / `grant` match W's binding.

A violation **refuses** the write, naming both seats. `musterd init --check` gets the read-only
version so entries already poisoned are found rather than tripped over.

### 6.1 The one deliberate block

Refusing here breaks warn-never-block on purpose. The failure is silent, cross-seat, and produced a
lie that survived weeks; the cost of a refusal is re-running one provisioning command. Nothing else
in this design blocks.

### 6.2 Scope boundary

Increment 2 does **not** touch `musterd agent`'s worktree/binding-writing behavior, which has its own
known clobber trap (one seat's binding written into a sibling worktree). It validates only what is
written into harness config.

## 7. Testing

- **Unit** — `observeModel()` per harness against fixture transcripts: well-formed, truncated, empty,
  field absent, unknown schema.
- **Precedence** — table test over observed × declared × absent, asserting the winner and whether the
  tripwire fires.
- **Regression** — assert `buildMcpEnv()` never emits `MUSTERD_MODEL` from a binding. This is the
  guard that stops this exact bug returning.
- **Integration, through the DB** — a session whose declared model is wrong ends with the roster
  showing the observed model and an `occupancy.model_attested` row recording the correction.
- **Increment 2** — an entry write targeting a sibling worktree's adapter path is refused; a
  mismatched grant is refused; a shared/global install is allowed.

## 8. Observability & Evaluation

- `occupancy.model_attested` already audits `old → new`; after this change a correction is
  attributable to an observation rather than to a human edit.
- The tripwire's `observed ≠ declared` case is the health metric: its rate over time measures how
  often provisioning snapshots rot. It should trend to zero once §6 lands.
- `musterd init --check` reports attestation state per workspace, so poisoned entries are countable
  across all seats rather than discovered one at a time.
- Regression watch: a rise in `unknown` attestation on Claude Code seats means the transcript format
  moved and `transcript-model.ts` needs updating — the degradation is visible, not silent.

## 9. Out of scope

- Verifying an attested model against the provider. Attested, never verified (ADR 101) stands.
- Inferring model from MCP `clientInfo` — ADR 120 forbids it. The contradiction check is a
  _warning_ signal only, never a source.
- Cursor fidelity. The slot exists and returns `undefined` until Cursor exposes something to read.
