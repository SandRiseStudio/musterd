# Guidance distribution — a version bump is not delivery

Bumping `GUIDANCE_CONTENT_VERSION` ships nothing on its own: a seat's `SKILL.md` only moves when someone runs the repair in that worktree, and for five days nothing told anyone to.

## What actually moves a seat's guidance

Guidance files (`.musterd/skill/*`, `.claude/skills/musterd*/SKILL.md`, `.claude/commands/musterd-*.md`, the Cursor rules) are **written by provisioning, not by any periodic job**. Nothing on this laptop rewrites them on merge — the auto-refresher rebuilds `dist` and bounces the daemon, and neither touches a worktree's guidance. The three ways a seat's guidance moves:

- `musterd init` in that worktree (full provision),
- `musterd init --refresh-guidance` (the targeted repair),
- a human doing it by hand.

So the delivery loop has exactly one live path: **the doctor notices staleness → the SessionStart nudge names it → a session runs the repair.** If the first link is silent, the files rot indefinitely and every guidance-shipping ADR is unobservable in the field while its tests are green.

## The five-day outage (2026-08-31; falsify: `git show <fix>^:packages/cli/src/onboard/doctor.ts` and run `inspectArtifactDrift` on any seat worktree — guidance comes back `[]`) <!-- claim: defect -->

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
- `.musterd/skill/orient.md is missing` — ADR 333's orient skill had never been written into this worktree (2026-08-31; falsify: `ls .musterd/skill/` in any seat worktree provisioned before ADR 333 landed), and nothing had ever said so. <!-- claim: defect -->

The repair works and always did: run against a v3-manifest fixture stamped v18, `init --refresh-guidance` moved every file to current and installed the missing `orient.md`.

## Why the tests were green

Every test in the `inspectProvisioning — guidance drift` block wrote a **v1** manifest, so the suite exercised the only manifest version the check could still see. The surface was fully covered and completely dead — see [correct by coincidence](correct-by-coincidence.md). A check whose gate is a schema version needs at least one test per version that exists in the field, and the fixture is where that gets decided.

## Guidance ships inside the CLI binary, so the question is really "how does this machine get a new CLI" (2026-09-06; falsify: on a packaged install, `musterd init --check` — a line naming the guidance version as a ceiling means this landed; a bare `✓ provisioning is coherent` with no version line means it did not) <!-- claim: defect -->

The section above fixed the doctor's blindness on this laptop. delta measured the same silence one machine over, on the cloud seat `/data/musterd-delta`, and the cause is different enough to be its own rule.

The steer that page produced said: *wait for autorefresh's `bounced the daemon on <sha>` line naming a sha at or past the merge, then refresh.* **On the cloud VM that signal is unsatisfiable** — autorefresh never reaches that daemon, which runs the image sha ([cloud seat from inside](cloud-seat-from-inside.md)). There is no bounce to wait for. The CLI there moves only when the image is rebuilt and the VM redeployed, so waiting is not a strategy and a redeploy is the delivery mechanism.

What delta measured, and did not repair, because measuring it was the finding:

- `SKILL.md` at `musterd:content v21` while main wrote v22.
- The VM was redeployed 13:24Z from `4636b396`; `git merge-base --is-ancestor 3648c7e5 4636b396` → **false**. The v22 bump is not in the image the CLI was built from.
- So `--refresh-guidance` there writes **v21 over v21** — a no-op that leaves the doctor satisfied. Delta stopped rather than manufacture the exact "you got v21 and your doctor now says you are current" state.
- `musterd init --check` ended `✓ provisioning is coherent`, with **no version comparison line at all**.

**Why every staleness surface is blind here at once** (2026-09-06; falsify: read `inspectGuidance`'s comparison in `packages/cli/src/onboard/doctor.ts` — a comparison against anything but `GUIDANCE_CONTENT_VERSION` means this is wrong). `inspectGuidance` compares each file's stamp against `GUIDANCE_CONTENT_VERSION` — the constant compiled into the CLI doing the comparing — so it is self-referential by construction and a v21 binary pronounces v21 files current. That is correct and useless. The backstop, `buildSkewNotes`, has two arms and both miss: (a) compares against the daemon, which on a cloud VM is the same image, and (b) compares against `origin/main`, which needs a git checkout a packaged install does not have. Nothing is broken; nothing can see. <!-- claim: defect -->

**Green is worse than quiet.** The five-day outage above was silence, and silence at least invites a second look. A ✓ is a positive claim of health, and it was made about a question the binary cannot answer.

| Install kind | How a new CLI arrives | What the doctor can compare against |
| --- | --- | --- |
| source checkout | `git pull` + build (`musterd service refresh`) | `origin/main` — a real answer |
| packaged (npm/brew) | `npm i -g @musterd/cli@latest`, `brew upgrade musterd` | itself, plus the daemon if it differs |
| baked image (cloud VM) | rebuild the image, redeploy the machine | itself — the daemon is the same image |

The doctor now states the **ceiling** rather than implying currency (2026-09-14; falsify: `packagedInstallNotes` in `packages/cli/src/runtime.ts` returning one note rather than two means this regressed). On a packaged install it says which guidance version this binary writes, that `--refresh-guidance` can only ever write what the binary carries, and that a ✓ means *"your guidance matches this CLI"* and not *"your guidance is current with main"*. `isPackagedCliInstall` cannot tell a baked image from an npm global — both are "no `pnpm-workspace.yaml` above the bin" — so the update line names both paths rather than the one that happens to fit the laptop. <!-- claim: defect -->

**The rule.** *A version constant compiled into a binary can only ever report on itself, so any check built from one is a statement about the binary, not about the world.* Say which it is at the point of the claim. And the routing half, which is how this reached a second machine at all: **a repair steer names a delivery path, and a delivery path is a property of the install kind** — naming only the one the author is standing in silently excludes every other. The cloud seat can detect its own staleness and cannot fix it; that repair belongs to whoever rebuilds the image.

## The rule this leaves

**A reader keyed to a schema version silently disables everything downstream of it when the schema moves.** The failure is not an error, a warning, or a wrong answer — it is an early return, which reads exactly like health. When you version a local-state file, grep for every reader of the old version and ask what each one does when the parse fails; `?.field` followed by `if (!field) return` is the shape to look for. Related: [instrument silence is not evidence](instrument-silence.md) — the doctor's quiet was a claim, and it went unchecked for five days because quiet is what "fine" looks like.

The rule caught its own fix. The first cut of that repair asked `kind === 'valid' || kind === 'legacy'` — which is a list of the manifest versions that exist *today* (3, and 2/1 as legacy), so a future v4 file would classify `invalid` and the check would go quiet again: this page's rule, violated one version ahead, in the change that wrote it. dolly caught it in review of #1115 and probe-measured it (v4 manifest + a v0-stamped skill → no drift). The shipped form asks whether the FILE is there — `loadProvisioning(cwd).kind !== 'missing'` — so a corrupt or future-version manifest gets its drift *reported* rather than silenced, and there is a v4 fixture pinning it. Worth noticing how easy the second commission was: knowing the trap by name did not stop it, and a reviewer did.
