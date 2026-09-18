# Uniform error is invisible to a disagreement guard

A check that fires on *disagreement* — this build against that one, my copy against yours — has one degree of freedom when both sides come from one shared source, and a fleet wrong the same way everywhere is the shape a shared build produces.

## The guard, and what it is keyed on

`checkoutBehindHooks` (`packages/cli/src/onboard/harnesses/claudeCode.ts`) is ADR 168's checkout-behind verdict as a predicate: self-heal must not run when some installed musterd hook was written by a **newer** musterd than this checkout, because repairing would downgrade what the newer build wrote. Its whole body is one comparison:

```ts
if (h.command.includes('musterd') && hookEpochOf(h.command) > FEATURE_EPOCH) return true;
```

That is a relation between two numbers, and it is the right guard for the job it was given. The trouble is what people then read out of its silence.

## Measured: it cannot fire on this machine (2026-09-18; falsify: `grep -o '# musterd-[a-z-]* e[0-9]*' ~/.claude/settings.json` and compare against `FEATURE_EPOCH` in `packages/protocol/src/feature-epoch.ts` — a hook epoch above the constant makes it fire) <!-- claim: defect -->

Every musterd hook installed on this laptop carries `e21`. `FEATURE_EPOCH` is `21`. So `21 > 21` is false at every one of the fifteen `~/agents-*` worktrees, and `checkoutBehindHooks` returns false for all of them — not because they are current, but because they are **identical**. Eleven of those worktrees have a `.claude/settings.local.json` with no musterd hook epoch in it at all, and the three hooks that do carry one live in the machine-wide `~/.claude/settings.json`, which every seat shares. One file, one epoch, one answer for everybody.

A guard fed by a single shared file has one degree of freedom across a fleet of fifteen. It can report a seat that ran ahead. It is structurally incapable of reporting a fleet that fell behind together, and a shared build is a machine for making fleets fall behind together.

## The fleet those guards were quiet about (2026-09-18; falsify: run `installedGuidanceEpoch` from `@musterd/protocol` over each `~/agents-*` directory) <!-- claim: other -->

While every hook-epoch check on this laptop read clean, the guidance actually installed in those same worktrees ranged over **sixteen epochs**:

| epoch | worktrees |
| --- | --- |
| 26 | big-body, izzo, miley, ryder |
| 25 | compo, dolly, stanley |
| 24 | sloane |
| 23 | ghost, kimi |
| 22 | schmidt |
| 21 | gptbot |
| 17 | wanderer |
| 10 | grokbot |
| none | live |

The two facts are not in contradiction, and that is the point worth keeping: the hook guard compares **hooks to this build**, while the thing rotting was **guidance across seats**. Nothing was lying. Nothing was broken. The check answered the question it was asked, and the question was not the one anyone needed answered — see [guidance distribution](guidance-distribution.md), where the same loop failed one layer down and for five days looked like a distribution problem when it was a detection problem.

## What made the spread visible

Not a better guard — an **attestation**. ADR 417 has each seat report the epoch of the files it is actually running, on its claim and again on every heartbeat, so the roster holds fifteen independent answers instead of one shared one. The census then becomes a query (`presences[].guidance_epoch`) rather than a shell loop over nine checkouts, and a seat sixteen epochs behind is legible as a row rather than as an absence.

The general form, and the reason this page is not just about hooks:

- **A comparison between two things can only see them differ.** If both sides are derived from the same source — one linked `dist`, one machine-wide settings file, one constant compiled into every copy — there is one degree of freedom and the guard has nothing to compare.
- **Per-actor self-report has one degree of freedom per actor.** That is what makes a spread visible at all, and it is why `guidance_epoch` is read from the seat's own files rather than from `GUIDANCE_CONTENT_VERSION`: attesting the constant would be the same self-referential trap one layer up, a binary that writes v26 pronouncing v26 current.
- **Silence from a disagreement guard is not evidence of currency.** Ask what the check would show *if the claim were false* — wiki rule 3. Here it shows the same thing, so it was never the check for this claim. Related: [silence is only evidence when someone was listening](silence-is-only-evidence-when-someone-was-listening.md).

## Limits of what is claimed here

The `checkoutBehindHooks` guard is **not** being called defective — it refuses a downgrade, it does that correctly, and no test of it is wrong. The claim is narrower: its silence was read, by this seat among others, as evidence that the workspaces were current, and it could never have carried that meaning.

Also unexercised in the field as of 2026-09-18: every workspace on this laptop is internally consistent, all its guidance files carrying one stamp, so ADR 417's disagreement ruling — a mixed workspace attests the **lowest** stamp it runs — has only ever fired in `packages/cli/src/client.guidanceEpoch.e2e.test.ts`, never against a real folder.
