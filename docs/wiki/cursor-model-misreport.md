# Cursor's hook reports a model the session is not running

On cursor-agent **2026.09.02-c22c1a3**, every Agent hook event carries a `model` / `model_id` that is not the model the session is running. musterd read that field as an observation until 2026-09-04 (ADR 198), which meant a Cursor seat could attest, with the top-of-ladder confidence reserved for measurements, a model it was not using.

## The measurement (2026-09-03, seat kimi)

Probed by temporarily instrumenting the observe path in a daemon checkout, reverted after capture. Every hook event — `sessionStart`, `postToolUse`, `afterShellExecution` — reported:

```
model: "gemini-3.8-flash"     (with a live generation_id)
```

while the session was running **kimi-k3** via cursor-agent. The misreport is at the Cursor source: musterd's observe path recorded faithfully what it was given.

Falsify, or check whether it is fixed: run a cursor-agent session on a model you have chosen deliberately, capture the hook stdin (the hook is `musterd session observe --stdin`), and compare the payload's `model_id` to the model actually answering. The claim here fails the moment `model_id` tracks the session.

## Why it was invisible

`modelDrift` fires when an **observation** disagrees with a **declaration**. An observation outranks a declaration (ADR 158), so the wrong value overwrote the seat's own declaration and the two became equal. The check that exists to catch exactly this could not see it — a false observation defeats drift detection by construction, not by accident.

That is the general shape worth remembering: **a tripwire that compares two sources is blind when the corruption is in the source it trusts more.**

## What changed (2026-09-04, ADR 383)

Cursor declares no `observeModel` probe, and it left `PROBE_CAPABLE_SURFACES`. A Cursor seat now attests its declared model (`MUSTERD_MODEL` / `binding.model`), which is honest, and drift can fire again. The probe is a two-line restore when the field is fixed; the pin test in `probeCapability.test.ts` makes sure the list and the registry move together.

Already-poisoned bindings need no repair: `observeCursorSession` drops a leftover observation on the next new conversation (ADR 268). Inside a still-running conversation the stale value survives until that conversation ends.

**What was deliberately not done:** letting a declaration outrank a hook observation. That inverts ADR 158's ladder, which exists because the opposite already failed — a provisioning snapshot in the environment once had a seat attesting `grok-4.5` for weeks while it ran `claude-opus-4-8`. The distinction to keep is that an observation beats a declaration, and a value that was never a measurement is not an observation.

## Still open

Reporting it upstream to Cursor. The reproduction above is the report; filing it needs a human. Not yet done as of 2026-09-04.
