# 321 — OpenCode as a first-class harness

- Status: proposed
- Date: 2026-08-25
- Builds on: [ADR 281](281-multi-harness-worktree-selection.md) (whose "a novel harness uses <!-- vocab:ok -->(slug predates ADR 296 vocabulary)
  surface `other` **until a separate protocol ADR adds the Surface**" clause this ADR is),
  [ADR 251](251-native-backend-musterd-as-its-own-harness.md) (the SURFACES + storage-CHECK
  playbook this follows for the second time), [ADR 006](006-cursor-surface.md) (the first surface
  addition), [ADR 031](031-codex-adapter-scope.md) / [ADR 216](216-codex-cli-residency-backend.md)
  (project-local config + CLI-output-as-evidence-boundary posture inherited from codex),
  [ADR 166](166-session-liveness-by-enumeration.md) (liveness by enumeration and the attribution
  rule), [ADR 270](270-mcp-reconciles-cursor-capture-without-hooks.md) (heartbeat-side capture
  when hooks don't exist), [ADR 027](027-non-invasive-harness-coexistence.md) (the guest posture
  every adapter keeps), [ADR 085](085-layered-guidance-surface.md) (layered guidance placement),
  [ADR 135](135-build-provenance-every-runtime.md) (why a protocol bump makes every seat rebuild)
- Lane: `01M0WYHNM0KZB3F22Y1PAZX0AT`
- Authored by ghost, 2026-08-25. The lane was claimed and then recovered mid-crash: the session
  drafting it runs inside opencode itself, which is both the subject and the evidence.

## Context

OpenCode is the fourth agent harness in daily use on this team's machines, alongside Claude Code,
Codex, and Cursor. Every harness-specific seam in musterd already admits it *behaviorally*:
`HarnessId` is an open schema (`packages/protocol/src/provisioning.ts:20-26`), the fragment
reconciler degrades unknown declared surfaces to `other`
(`packages/cli/src/onboard/reconcile/fragments.ts:144-146`, ADR 281's deliberate escape hatch),
and liveness falls back to slot-based verdicts when no scanner matches
(`packages/cli/src/session/liveness.ts:120-128`). So an opencode seat can *work* today.

What it cannot be is **legible**. With surface `other`:

1. **Presence is anonymous in a field we defined for exactly this.** Roster rows read "other"
   where every peer row names its harness; delivery hints, attestation chains, and any
   surface-scoped policy cannot see it.
2. **Liveness reads the wrong transcripts.** The scanner selection treats an unknown harness as
   Claude (`enumerate.ts:120-128` fallback), so an opencode seat's enumerated sessions are
   someone else's JSONL files — the ADR 166 evidence path produces confident nonsense rather
   than falling through to slots.
3. **Residency cannot host it.** There is no `opencode` row in the actuator backend map
   (`packages/cli/src/commands/host.ts:44-58`), so `musterd host` can never wake one.
4. **Provisioning writes nothing.** No adapter means every workspace hand-wires what `musterd
   onboard` exists to do.

Each of these was the known cost of ADR 281's escape hatch, paid until the harness earned its own
protocol ADR. Opencode has earned it: it is the harness this seat runs in, survived a terminal
crash mid-lane in, and the one whose integration facts we can verify against the running binary.

Facts verified against opencode 1.18.23 on 2026-08-25 (this machine):

- **Config**: project-local `.opencode/opencode.json` (or `.jsonc`) plus a global
  `~/.config/opencode/opencode.json(c)`; MCP servers are entries under the config's `mcp` key
  (`opencode mcp add|list` manages them). Same two-tier shape as codex, same guest-posture
  implications.
- **Guidance**: opencode reads **AGENTS.md natively** — the primer managed block
  (`packages/cli/src/onboard/primer.ts`) is already its guidance file with zero new shell.
  The canonical skill at `.musterd/skill/SKILL.md` is harness-neutral and referenced from there.
- **Sessions**: `opencode session list --format json` emits
  `{id, title, updated, created, projectId, directory}` — including the working directory as a
  plain absolute path. Attribution needs no slug decoding; the ADR 166 trap does not apply.
- **Resume**: `opencode run --session <id> "<prompt>"` continues a named session headlessly
  (`--fork` available if isolation is ever needed).
- **Hooks**: none comparable to Claude/Cursor hook tables. There is a plugin system, but plugins
  are executable TypeScript loaded into the harness process — a different trust object entirely.

## Decision

Opencode becomes a first-class harness across all six seams, landed together — shipping the
surface without the backend would put a legible-looking row on the roster that residency still
cannot wake and liveness still cannot judge.

### 1. Protocol: `SURFACES += 'opencode'`

`packages/protocol/src/acts.ts:41` gains `'opencode'` between `'codex'` and `'cursor'`
(placement beside its sibling CLI harnesses; order is presentation-only). Additive enum widening,
versioned per SPEC rules; `SPEC.md` §21's Surface sentence and the reserved-surfaces list gain
it in the same commit (hard rule 3). Every zod site that validates a surface
(`PresenceSchema`, hello/heartbeat/presence frames, claim body, delivery hints) widens
automatically via `z.enum(SURFACES)`. This is the "separate protocol ADR" ADR 281 called for;
that ADR's `other` degradation stays for genuinely unknown harnesses.

### 2. Storage: migration v44 rebuilds the presence CHECK

The presence table's `CHECK (surface IN (...))` hard-codes the enum in two places: v1 DDL
(`packages/server/src/db/schema.ts:37`) and migration v39
(`packages/server/src/db/migrations.ts:789`). SQLite cannot ALTER a CHECK, so v44 follows the v39
playbook exactly: create-table-with-new-CHECK → copy → drop → rename, inside one transaction.
Both test pins (`db.test.ts:329`, `integration.test.ts:1088`) gain the new value. The doc mirror
in `docs/architecture/01-data-model.md` §50-55 updates in the same commit.

### 3. Provisioning adapter: project-local only, jsonc-honest

`harnesses/opencode.ts` implements the `Harness` contract
(`packages/cli/src/onboard/harness.ts:218-292`): id `opencode`, label "OpenCode", surface
`opencode`. Detection is the presence of `.opencode/` or an `opencode` binary on PATH.
Configuration writes **only** the project-local `.opencode/opencode.json` — an upsert of the
`mcp.musterd` entry pointing at the same stdio command every other adapter writes — following the
codex posture (ADR 031): the global `~/.config/opencode/` is read, never written. Two honesty
rules:

- If the project instead carries `opencode.jsonc`, musterd does not manage a second parallel
  config file; detect reports `cannot-manage` with that reason rather than writing `.json` beside
  it and letting opencode's precedence decide silently.
- The upsert preserves unknown keys (JSON round-trip, minimal diff), matching the reconciler's
  fingerprint expectations.

Unprovision removes exactly the `musterd` entry and leaves the file if anything else remains.

### 4. Guidance: AGENTS.md already is the shell — add none

No `.opencode/rules` file, no opencode-flavored skill copy (ADR 085's layering assigns shared
guidance to shared files). The primer block in AGENTS.md and the canonical skill cover opencode
as they cover claude-code; `guidanceTargets`/`establishedHarnesses`
(`packages/cli/src/onboard/guidance.ts:205-211`) need no new target. Opencode reads its guidance
from AGENTS.md, so the adapter's guidance work is a subtraction: nothing to write, so nothing
can drift.

### 5. Fragment reconciler slot

`registryOrder` (`fragments.ts:124`) becomes `['claude-code','cursor','codex','opencode',
'musterd']` and `harnesses/index.ts` registers an opencode `HarnessAdapter` implementing the
inspect/intents half of the ADR 282 contract for the `mcp.musterd` entry. Ledger fragments from
an opencode workspace stop degrading through the `other` path; existing ledgers are unaffected
(fingerprinting keys by resource, not by registry membership).

### 6. Session enumeration + liveness: the CLI is the evidence boundary

`enumerateOpencodeSessions` (`packages/cli/src/session/enumerate.ts`) shells
`opencode session list --format json` and parses the output through a strict
`OpencodeSessionSchema = { id, updated, directory }` (hard rule 4 — external input parsed at the
boundary, exactly like codex rollouts per ADR 216; `title`/`projectId`/`created` are display
data and never parsed). Attribution matches `directory` against the workspace root via
`findWorkspaceDir`'s walk-up — no slug decoding, because opencode hands us the absolute
path directly. Liveness inherits the ADR 166 window semantics unchanged
(`LOCAL_SESSION_LIVE_MS`); the scanner-selection branch in `liveness.ts` gains its `opencode`
case so an opencode seat's verdicts come from its own harness's rows, never another harness's
transcripts.

We deliberately do **not** read opencode's storage directly (`~/.local/share/opencode/
opencode.db`): the schema is private, WAL-contended with live sessions, and version-coupled
to the harness release. The CLI JSON surface is slower and coarser but is the stable public contract;
the codex precedent (ADR 216) chose the same trade and never regretted it.

One boundary drawn deliberately narrower than first drafted: the selection chain's terminal
**Claude fallback stays for genuinely unknown harnesses**, because "unknown" there includes the
legacy pre-ADR-281 captures that declare no harness at all — for those, the Claude scanner is the
best available evidence, and the fallback is the documented historical contract (`liveness.ts`).
Opencode seats stop paying for it the moment their harness name routes to §6's scanner; fixing
the fallback itself for every future harness is its own decision, not smuggled into this one.

### 7. Wake backend: fresh and resume rows

`host/backends/opencode.ts` implements `ActuatorBackend` alongside codex's:

- fresh: `['run', line]`
- resume: `['run', '--session', sessionId, line]`

Registered as `'opencode'` in `commands/host.ts`. Watchdog, roster verification, and lease-bound
verification are the shared mechanics — ADR 241's invariant needs no opencode-specific thought.

### 8. Capture: heartbeat-side reconciliation only — no plugins

Opencode has no hook table, so SessionCapture-on-start/end does not exist for it in v1. Capture
for opencode seats rides the ADR 270 pattern: the MCP adapter reconciles observed state onto
heartbeats, occupancy attestation follows the observed harness (ADR 275), and enumeration supplies
the session identity. Plugin-based capture was considered and rejected for v1: a plugin is
executable code injected into the harness process, which crosses from configuration into
installation — a different trust object than anything ADR 027's guest posture covers, and one
whose API is pinned to opencode internals that move between releases. Revisit only if
heartbeat-side reconciliation proves too coarse in practice, and then as its own ADR.

## Consequences

- **Every resumable seat rebuilds again.** The protocol change bumps `FEATURE_EPOCH`; by ADR 135
  each seat attests its dist stamp, so the epoch-14 rebuild dance stanley shepherded through the
  team this week (inbox, 10:06–10:13) repeats once this lands — and the `surface_globs`
  legacy-mirror drop precondition he is tracking waits for the *new* epoch, not 14. Sequence the
  merge announcement accordingly.
- Presence rows may now attest `opencode`; `presenceLabel.ts` gains its friendly label; the web
  viewer renders it without a fan-out release since it consumes the roster over the wire.
- Migration v44 runs on every daemon upgrade; the presence-table rebuild is O(rows) and trivial
  at dogfood scale, as it was for v39.
- Coverage floors hold by construction: the enum widening is additive in `@musterd/protocol`
  (≥95% lines), the migration extends the pinned-CHECK pattern (≥85% server), and the adapter /
  enumerator / backend land with their own unit tests using fixture JSON from a recorded
  `session list` invocation.
- Architecture trees update for each new file (`arch-trees:check`); `02-protocol.md`'s frame
  examples need no edit (they cite concrete surfaces, not the closed list).
- An opencode seat that never runs `musterd onboard` behaves exactly as today — `other`,
  slot-liveness, unwakeable. First-class status is opt-in like every harness's.
- _Implementation note (dated 2026-08-25): all six seams landed on this branch._ The protocol enum
  widened (epoch 15), migration 44 rebuilt the presence CHECK with `model_source` riding the
  enumerated column list, and the adapter / fragment slot / enumerator / wake backend shipped with
  31 new unit tests (fixture-binary injection for the CLI boundary, memory-Fs containers for the
  reconciler). Two decisions moved during implementation, both recorded here rather than silently:
  §6's Claude-fallback clause was narrowed to what the code actually needed — the fallback stays
  for genuinely unknown harnesses because "unknown" includes legacy pre-ADR-281 captures that
  declare no harness, for whom the Claude scanner is the best available evidence; and residency enrollment gained
  an opencode capability preflight (`opencodeBin.ts`, mirroring codex's) that §7 did not name but
  whose absence would have enrolled un-wakeable seats — the exact failure the codex probe exists
  to prevent.

## Observability & Evaluation

**Traces.** Presence rows attesting surface `opencode` with the standard provenance/workspace
fields; `wake_leases` rows keyed `harness: 'opencode'` flowing through the existing
deferred/failed/cost taxonomy unchanged; reconcile journal rows naming the opencode adapter;
enumeration feeding liveness verdicts whose `source` field distinguishes enumerated-vs-slot as
it does for every other harness.

**Eval.** Done when, on a real workspace: (1) `musterd onboard` provisions an opencode session
that joins, claims, and shows `surface: 'opencode'` on the roster; (2) liveness for that seat
derives from `opencode session list` output — verifiable by touching a transcript-free interval
and watching the verdict flip to slot-sourced; (3) `musterd host` wakes a registered opencode
seat fresh and resumes it by session id, with the ADR 241 lease match holding on both paths;
(4) removing musterd's MCP entry by hand is repaired by `musterd harness configure` through the
reconciler, journal-recorded.

**Experiment.** n/a for the decision itself — this is parity plumbing with no behavioral
hypothesis to compare; the six seams above each carry their own acceptance evidence in Eval.
The one measured claim worth keeping once live: an opencode seat's enumerated-liveness verdicts
should disagree with slot-based verdicts at the same rate other CLI harnesses do; if opencode
seats show systematically stale or absent enumeration against a working binary, that falsifies
the CLI-as-evidence-boundary choice in §6 and reopens reading the storage directly.
