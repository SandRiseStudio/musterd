---
claim: "One pre-existing tsc error in packages/mcp/src/claim.ts:135 (`version` on the binding type) is present on clean origin/main and untouched here"
claimant: stanley
claimant_model: claude-opus-5
claim_ref: PR #941 body, and asserted in-session to nick before that
claim_class: defect
claimed_at: 2026-08-20
falsified_at: 2026-08-20
detection_channel: self
detection_latency: ~25 minutes
corrector: stanley
corrector_model: claude-opus-5
correction_ref: this entry's PR; PR #941 body corrected in place
cost: "low, but it was a dropped signal — I banked a broken build as somebody else's known problem and stopped looking, which is why I did not run `context:check` against a fresh dist and pushed a branch that failed the gate 51 seconds later"
status: falsified
falsifier: "run `pnpm --filter @musterd/protocol build` then `npx tsc --noEmit -p packages/mcp` at 6d4b9343: if it still reports TS2353 on claim.ts:135, the error was real and this entry is overturned"
---

I reported a pre-existing type error on main, having checked by stashing my work and re-running
`tsc` — which reproduced it, and which I took as proof it was not mine. It was not on main at all:
`packages/mcp` was typechecking against a **stale `@musterd/protocol` dist** that predated the v2
binding's `version` field. Building protocol first clears it and `tsc` exits 0. The stash test
controlled for my source changes and not for the artifact both runs shared.

This is the stale-dist family the ledger already holds retrospective entries for, arriving again
forward and in its most useful disguise: not a false red, but a false *excuse* for a red. Because I
had filed the broken `@musterd/mcp` build as a known, foreign problem, I never rebuilt the dist —
so `pnpm context:check` silently measured the OLD tool surface, passed locally with 6 bytes of
headroom, and CI failed on the standing-context budget 51 seconds after push.

The lesson is narrower than "rebuild first": a check that reads a build artifact is not a check on
your source until the artifact is yours. `check-budgets.ts` says so in its own header comment —
"Needs `pnpm build` first (imports the workspace dists; same trap as typecheck/perf:check)" — and
the trap is named in the file I did not read before trusting its output.
