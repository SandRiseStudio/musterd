# 383 — A misreported model is not an observation: drop the probe, never invert the ladder

- Status: proposed
- Date: 2026-09-04
- Builds on: [ADR 101](101-model-as-a-variable.md) (a model is a harness fact a human must not stamp), [ADR 158](158-model-attestation-truth.md) (the attestation ladder: observed > environment > binding), [ADR 198](198-cursor-hooks-observe-model.md) (the Cursor probe this removes), [ADR 268](268-clear-model-observed-on-session-change.md) (a leftover observation is a stopped clock), [ADR 314](314-correlated-models-correlated-mistakes.md) (why an attested model has to be true: correlated models make correlated mistakes)
- Lane: 01M1NF3Z72Q68WXSAK4GD8XPSX (probed by kimi, decided here)

## Context

ADR 198 read Cursor's hook payload for `model_id` and stamped it as an **observation** — the top rung of the ADR 158 ladder, above every declaration, because an observation is a measurement and a declaration is a snapshot that rots.

kimi probed the payload on 2026-09-03 (temporary instrumentation in a daemon checkout, reverted after capture). On cursor-agent **2026.09.02-c22c1a3**, every hook event — `sessionStart`, `postToolUse`, `afterShellExecution` — reported `model: "gemini-3.8-flash"` with a live `generation_id`, while the session was running **kimi-k3**. musterd's observe path was faithful; the field it read was wrong.

Three consequences, in the order they bite:

1. **The seat attested a model it was not running.** The correlated-failure charter (ADR 314) and `reviewGrade`'s cross_family / cross_model / same_model decisions are computed from that field. A wrong model is not a cosmetic error there; it silently corrupts the input to who may review whom.
2. **The tripwire could not fire.** `drift` is true only when an observation and a declaration disagree. Here the observation **overwrote** the declaration, so declared == observed == wrong, and `modelDrift` had nothing to compare.
3. **It was durable.** `binding.model_observed` is deliberately never erased by a failed read (ADR 158's never-erase rule), so a bad observation outlives the session that produced it.

## Problem

A harness reports a model field that does not track the session. Decide what musterd does about a source it can no longer trust, without weakening the rule that made attestation trustworthy in the first place.

## Decision

**A field that does not track the session is not an observation. Remove the probe; do not re-rank the ladder.**

1. **Cursor declares no `observeModel`.** The slot is gone from `packages/cli/src/onboard/harnesses/cursor.ts`, with the measurement and the restore condition in the comment where the next reader will look. The hook keeps everything else it does — session capture, the ADR 333 orientation injection, the ADR 369 interrupt check. Only the model claim goes.
2. **Cursor leaves `PROBE_CAPABLE_SURFACES`.** That list answers "could an observation have been made here?", and the honest answer for Cursor is now no. Leaving it in would nag every Cursor seat that it is attesting a declaration where an observation was reachable, about a probe that deliberately does not exist.
3. **Attestation falls through to the declared tier**, which is what a Cursor seat should have been attesting all along, and `shouldWarnUnobservedModel` correctly stays silent.
4. **Already-poisoned bindings self-heal.** `observeCursorSession`'s ADR 268 branch drops a leftover observation on the next new conversation, so no migration and no manual repair. Within a still-running conversation the stale value survives, which is bounded and honest.
5. **The absence is tested, not incidental.** `observeModel.test.ts` names Cursor as the one deliberate exception to the evenness contract, so a harness cannot quietly lose its probe — that would be this defect's mirror image, and the evenness contract exists to catch it.

### Rejected: let a declaration outrank a hook observation (the framing the lane arrived with)

This is the tempting fix and it is the wrong one. ADR 158 inverted exactly this ordering **because the opposite failed in production**: provisioning baked a wire-time snapshot into the environment — the top rung — and one seat attested `grok-4.5` for weeks while running `claude-opus-4-8`, with nothing downstream able to correct it. Re-elevating declarations, even for one harness, re-opens that failure the moment a Cursor seat's binding goes stale, and it trades a loud wrong answer for a quiet one.

The precedent worth keeping is the distinction, not the ranking: **an observation beats a declaration, and a value that was never a measurement is not an observation.** The fix belongs at the classification boundary, not in the ladder.

### Rejected: keep the probe and mark its output untrusted

Needs new wire vocabulary — a fourth attestation source or a trust flag on `WIRE_ATTESTATION_SOURCES` — so it is a protocol change with an ADR of its own, to carry a value nothing would then be allowed to use. Absence already says everything a trust flag would.

### Rejected: keep the probe and let `modelDrift` sort it out

It cannot. Drift compares an observation to a declaration; this defect makes them equal. The check is blind here by construction, which is precisely why the defect survived long enough for a probe to find it.

### Not decided here: reporting it upstream

Filing this with Cursor is worth doing and needs a human to do it; the reproduction is in the wiki page. Named so it is not mistaken for done.
Follows-up: none — an upstream report is nick's to file and needs no musterd change (2026-09-04)

## Observability & Evaluation

- **Traces:** unchanged. A Cursor occupancy now carries `model_source: 'environment' | 'binding'` instead of a false `observed`, so the existing `model_source` collection (lane 01M1MAQRP9) measures this directly: the share of Cursor sessions attesting a declaration should go to 1.0, and `modelDrift` regains the ability to fire on a Cursor seat whose declaration is stale.
- **Eval:** the falsifiers that ship with this are `observeModel.test.ts` (Cursor declares no probe; a payload carrying `model_id` produces nothing), `probeCapability.test.ts` (the list and the registry agree, so both halves must move together), and `session.test.ts` (a new conversation drops an observation the old probe left behind).
- **Experiment:** n/a — a trust decision, not a comparison. The measurement that drove it is one probed session, which is enough to know the field is not the session's model and not enough to characterise when it is right; the restore condition is stated as a falsifier rather than a schedule.
- **Restore condition:** re-run the capture in `docs/wiki/cursor-model-misreport.md` against a newer cursor-agent. If `model_id` tracks the running model, restore the probe and the list entry together — it is a two-line revert, and the pin test enforces that both move.
