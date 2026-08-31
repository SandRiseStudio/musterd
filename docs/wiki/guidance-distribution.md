# Guidance distribution — a version bump is not delivery

Bumping `GUIDANCE_CONTENT_VERSION` ships nothing on its own: a seat's `SKILL.md` only moves when someone runs the repair in that worktree, and for five days nothing told anyone to.

## What actually moves a seat's guidance

Guidance files (`.musterd/skill/*`, `.claude/skills/musterd*/SKILL.md`, `.claude/commands/musterd-*.md`, the Cursor rules) are **written by provisioning, not by any periodic job**. Nothing on this laptop rewrites them on merge — the auto-refresher rebuilds `dist` and bounces the daemon, and neither touches a worktree's guidance. The three ways a seat's guidance moves:

- `musterd init` in that worktree (full provision),
- `musterd init --refresh-guidance` (the targeted repair),
- a human doing it by hand.

So the delivery loop has exactly one live path: **the doctor notices staleness → the SessionStart nudge names it → a session runs the repair.** If the first link is silent, the files rot indefinitely and every guidance-shipping ADR is unobservable in the field while its tests are green.

## The five-day outage (2026-08-31; falsify: `git show <fix>^:packages/cli/src/onboard/doctor.ts` and run `inspectArtifactDrift` on any seat worktree — guidance comes back `[]`)

Every seat workspace on this laptop sat at `musterd:content v18` while `main` wrote v19, and `musterd init --check` reported **no guidance drift at all**. v19 landed 2026-08-26 (`5e88277a`) and reached nobody. dolly measured the same thing one version earlier on 2026-08-27 (all seven seats at v17 with v18 on main) and read it as a distribution failure; it was a **detection** failure, and the distinction matters because the repair was never broken.

The cause, in one line: `inspectGuidance` gated on `readProvisionManifest`, which parses `version: z.literal(1)`.

ADR 281 moved `.musterd/provisioned.json` to version 2 and ADR 282 to version 3. Every provisioned worktree therefore fails that v1 parse, `readProvisionManifest` returns `null`, and the check returned before reading a single content stamp:

```ts
const recorded = readProvisionManifest(cwd)?.guidance;
if (!recorded) return { drift, notes }; // pre-085 / never written — nothing claimed, nothing to check
```

The comment is the whole defect. Its premise — *no v1 record means this folder predates guidance, so there is nothing to check* — was true while there was one manifest version, and became false the moment a second existed. See [a constraint outlives its premise](constraint-outlives-its-premise.md); this is that shape with a version number as the premise.

Two consequences, both measured on `agents-izzo` before the fix:

- `8 musterd guidance files are v18, current is v19` — invisible.
- `.musterd/skill/orient.md is missing` — ADR 333's orient skill had never been written into this worktree (2026-08-31; falsify: `ls .musterd/skill/` in any seat worktree provisioned before ADR 333 landed), and nothing had ever said so.

The repair works and always did: run against a v3-manifest fixture stamped v18, `init --refresh-guidance` moved every file to current and installed the missing `orient.md`.

## Why the tests were green

Every test in the `inspectProvisioning — guidance drift` block wrote a **v1** manifest, so the suite exercised the only manifest version the check could still see. The surface was fully covered and completely dead — see [correct by coincidence](correct-by-coincidence.md). A check whose gate is a schema version needs at least one test per version that exists in the field, and the fixture is where that gets decided.

## The rule this leaves

**A reader keyed to a schema version silently disables everything downstream of it when the schema moves.** The failure is not an error, a warning, or a wrong answer — it is an early return, which reads exactly like health. When you version a local-state file, grep for every reader of the old version and ask what each one does when the parse fails; `?.field` followed by `if (!field) return` is the shape to look for. Related: [instrument silence is not evidence](instrument-silence.md) — the doctor's quiet was a claim, and it went unchecked for five days because quiet is what "fine" looks like.

The rule caught its own fix. The first cut of that repair asked `kind === 'valid' || kind === 'legacy'` — which is a list of the manifest versions that exist *today* (3, and 2/1 as legacy), so a future v4 file would classify `invalid` and the check would go quiet again: this page's rule, violated one version ahead, in the change that wrote it. dolly caught it in review of #1115 and probe-measured it (v4 manifest + a v0-stamped skill → no drift). The shipped form asks whether the FILE is there — `loadProvisioning(cwd).kind !== 'missing'` — so a corrupt or future-version manifest gets its drift *reported* rather than silenced, and there is a v4 fixture pinning it. Worth noticing how easy the second commission was: knowing the trap by name did not stop it, and a reviewer did.
