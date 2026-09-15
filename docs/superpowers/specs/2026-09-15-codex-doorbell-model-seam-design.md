# Codex doorbell model seam design

## Goal

Make a raised interrupt-class Act reach an active Codex model at the next supported local tool
boundary, while preserving Codex's causal model observation and making stale hook commands visible.

## Scope

The change has three connected parts:

1. `codex-hook post-tool-use` writes its existing `model_observed` value, performs the same
   lease-authenticated interrupt read Cursor uses, and emits Codex's structured additional-context
   JSON only for a raised daemon line.
2. Codex hook rendering and inspection use exact event/type/command tuples carrying feature epoch
   20. A newer installed epoch is healthy and identifies this checkout as behind; a missing, older,
   or text-different owned tuple is repairable drift.
3. Tests pin delivery, quiet/error silence, ownership-preserving rewrite, both epoch directions, and
   git-common-dir inspection. The live clause-8 reading is recorded separately and never inferred
   from tool registration.

## Non-goals

- No `Stop` hook, turn-end continuation, peer injection, or idle-prompt delivery.
- No change to interrupt-class selection, protocol schemas, server endpoints, authentication model,
  permissions, or wake behavior.
- No new dependency or vendor write.

## Data flow

```text
Codex PostToolUse event
  -> protocol parser validates event, session id, workspace, model
  -> codex-hook writes local model observation
  -> shared hook interrupt reader uses the bound Member credential + Presence lease
  -> daemon returns quiet or one composed line
  -> quiet/error: no stdout
  -> raised: hookSpecificOutput.additionalContext JSON -> Codex model context
```

The post-tool-use command remains the configured entrypoint. It owns neither the interrupt decision
nor the text of the notice; both stay on the daemon read path.

## Failure handling

All hook failures are fail-open. Invalid event input, a missing binding, missing credential, muted
nudge, stale lease, or HTTP failure emits no stdout and returns successful hook completion. The local
model observation remains independent of daemon reachability and is written before the read.

## Drift behavior

The desired hook specification is one ordered source of truth. It renders exact commands with a
marker and `e20`. Reconciliation identifies marker-owned handlers and replaces only those handlers
when their command differs. The inspector compares the same rendered command. It reports newer
epochs as a checkout update requirement, never a hook repair; older/different commands are stale and
repairable. Both workspace and git-common-dir copies use that rule.

## Verification

- A raised fixture returns exactly one Codex `hookSpecificOutput.additionalContext` JSON object.
- Quiet, malformed, and daemon-error fixtures return no stdout.
- The model-observation write still occurs before a quiet or failed interrupt read.
- A marker-preserving stale command and a newer epoch produce different doctor guidance.
- A user-owned command remains byte-for-byte unchanged through refresh.
- The authorized live run records its Codex version, musterd tool discovery/callability, and reconnect
  result as evidence, not as a universal claim.
