# Skills that travel — every musterd practice that ships without the daemon

**Status:** sweep, 2026-09-16–17; lane `01M2PAM2RF`; traction-plan §9. Ordered list of the
practices musterd runs on that can ship as standalone skills — a `SKILL.md` a stranger installs in
Claude Code, Codex, or Cursor with no musterd daemon — each with the honest line about what it
cannot do without one. That line is the doorway: a skill installed is a person who has met the
practice, and the README's last sentence tells them where the practice has a roster. nick's cadence
(2026-09-16): the sweep first, then **3–4 days per skill**. The order below is the October schedule.

## 1. What qualifies

A practice qualifies when all three hold:

- **It works on one machine with no server.** The skill needs at most a file convention and a
  small script. Anything that needs a roster, presence, a wake, or attestation is the product, not
  a skill — it goes in the "does not travel" list at the end, and its absence is the README line.
- **It is decided, not folklore.** An ADR or the rendered guidance (`packages/protocol/src/guidance.ts`)
  says what the practice is; the skill restates it in a stranger's vocabulary (ADR 296 glossary
  words stay canonical; wire identifiers do not appear).
- **A stranger benefits in their first session.** Not "our team's convention" — a thing a solo dev
  on two harnesses or a five-person team with agents would keep after trying it once.

Every skill carries the same one-sentence positioning (ADR 320's canonical statement, register
adapted) and ends with the same line: *From the musterd team — the coordination layer where agents
and humans are peers. This skill is the practice; musterd is where it has a name, a roster, and a
record. musterd.io.*

## 2. Where they live (the repo-layout decision)

**One repo, `SandRiseStudio/musterd-skills`, a directory per skill** — `skills/<name>/SKILL.md`
plus any script — for everything that is a `SKILL.md`. Separate repos only for things with a
runtime (`agent-whiteboard`, which has an MCP server and an npm package and already meets ADR 330's
extraction test). Reasons: one install line (`npx skills add SandRiseStudio/musterd-skills`) and
one Claude Code plugin-marketplace listing cover every skill; the 48-hour reply rule from
traction-plan §8 is one repo's issues, not eight; stars and forks accrue to one place a stranger
can find. Codex and Cursor reach is through the same `skills` CLI, which installs a `SKILL.md`
into each harness's skill directory — **verify the Codex and Cursor install paths on the first
skill before the README claims them.**

*Correction 2026-09-19 (ryder, lane `01M2XEB0N3`):* the in-repo shape was already decided by
[ADR 299](../decisions/299-committed-skill-home-and-vendoring.md) — one canonical harness-neutral
body at `.agents/skills/<name>/SKILL.md`, thin per-harness bridges that point at it rather than copy
it, and `PROVENANCE.md` + `LICENSES/` for adapted material. The `musterd-skills` repo inherits that
layout; the open item above is the bridge-install verification, not the layout.

*Open item closed 2026-09-21 (dolly, lane `01M32JZHGG`):* the per-harness read paths are verified
against this repo's own provisioning rather than assumed, and the table is in the S1 skill body
(`.agents/skills/skill-home-and-provenance/SKILL.md`). The row that changes a plan: **Codex has no
project-level skill or rule shell** — it is reached from `AGENTS.md`, so any README sentence
claiming "installs into Claude Code, Codex and Cursor alike" is false as written. Claude Code reads
`.claude/skills/<name>/SKILL.md`, Cursor `.cursor/rules/<name>.mdc`, Grok `.grok/skills/<name>/SKILL.md`.
Falsifier: provision a seat and list what each harness loads. What is still NOT verified, and what
§2's install line depends on: whether the third-party `skills` CLI writes to those paths — that is a
claim about someone else's tool and needs a real install on the first published skill before the
README says it.

## 3. The ordered list

Cost is at nick's 3–4-day cadence: a `SKILL.md`, a README with the doorway line, one worked
example, a test where there is a script. Reach: CC = Claude Code, CX = Codex, CU = Cursor.

| # | Skill | The practice, in one line | Source | Cannot do without the daemon (the doorway) | Reach | Ships |
|---|---|---|---|---|---|---|
| 1 | **agent-whiteboard** | A shared whiteboard for a human and an agent to brainstorm on, with the agent drawing and reading the same canvas | ADR 330; `packages/whiteboard` (exists) | Nothing — it is deliberately standalone; the doorway is the brainstorm's *output* landing in a lane | CC CX CU (MCP) | Sep 23 |
| 2 | **cross-family-review** | Before merge, a review by a model of a *different family* than the author; four questions — intent, principles, usable, feel; the accept *is* the verdict, there is no separate close | ADR 202, ADR 188 (graded ladder), ADR 314/172 (family as the correlation boundary) | Nothing attests that the reviewer's model actually differed from the author's; the verdict is a claim, not a record | CC CX CU | Sep 27 |
| 3 | **board-loop** | Claim before you build; one owner per surface; submit → someone else accepts; overlap is a warning at claim time, never a conflict at merge time. A `LANES.md` convention and a script that renders and validates it | ADR 150, 083/084, 126; guidance "Owning work in a lane" | Nothing stops two sessions claiming the same lane — one file, no identity, no gate | CC CX CU | Oct 1 |
| 4 | **harness-inbox** | The acts vocabulary and the loop — check the inbox at task boundaries, `status_update` on start and finish, `request_help` when blocked, `ask` a human with a tier and a clock — over a shared file between two sessions on one machine | ADR 145, 147, 088, 103; SPEC acts table | No roster, no presence, no delivery status, no attestation of who wrote a line; silence is not a recorded fact | CC CX CU | Oct 5 |
| 5 | **wiki-claims** | Durable knowledge as dated, falsifiable claims in `docs/wiki/`: line 1 title, one-sentence summary, defect claims carry a date and a falsifier, corrections strike-and-date rather than overwrite, an index generated not written; a checker that fails the page otherwise | ADR 259; `docs/wiki/README.md`; `scripts/check-wiki.ts` | Nothing — but the *who wrote it* is a git author, not an attested seat | CC CX CU | Oct 9 |
| 6 | **orient-and-remember** | Session start: read your memory, read what is addressed to you, handle that before anything else, stamp oriented. Session end: save one note — what you were doing, decisions mid-flight, where you left off. A memory-file convention and the two rituals | ADR 093, 049; guidance "Orient this seat session" / "Saving your memory" | Memory is a file on one machine; nothing carries it to another occupant of the same seat, and there is no inbox to read | CC CX CU | Oct 13 |
| 7 | **ask-a-human** | How an agent asks a person: species (consult / approve / escalate), tier (blocking holds; standard and advisory proceed when the clock runs out and *write down that they proceeded*), the question in one line, the outcome recorded | ADR 147, 149, 153, 260 | The clock is honour-system; nothing routes the ask to a person who is actually present, and "proceeded without an answer" is a note, not an audit row | CC CX CU | Oct 17 |
| 8 | **merge-on-the-word** | The close discipline: CI green on the exact head SHA, the SHA verified identical to the run, merged on a named human's word, the branch gone, and the lane told with PR + SHA + who authorised — done is two claims, not one | wiki `shipping-a-pr`, `running-the-gates`, `git-safety`; ADR 192, 305 | The "who authorised" is a commit-message string, not a recorded act by that person | CC CX CU | Oct 21 |
| 9 | **adr-amendments** | Decisions as numbered ADRs whose `## Decision` is frozen once accepted; changes are dated amendments in Consequences, never rewrites; numbers are published, not just read; a checker that refuses edits to a frozen section | ADR 223; wiki `amending-an-adr`; `scripts/check-change-adr.ts` | Nothing | CC CX CU | Oct 25 |
| 10 | **one-meaning-per-word** | A canonical glossary with a linter: each term means one thing across spec, CLI, docs and UI; banned near-synonyms named; grandfathering by date | ADR 296; `scripts/check-vocab.ts`; brand.md §5 | Nothing | CC CX CU | after launch |
| 11 | **shared-red** | When something is broken for everyone: report once with what you found, park your work, converge on the incident; never start new work into a shared red | guidance "Shared blockers — report, park, converge" | No shared board to converge *on*; the incident is a file | CC CX CU | after launch |
| 12 | **research-radar** | A weekly scan of new multi-agent / human-agent research, triaged into "changes a decision / worth a wiki page / noted", with the intake written as a dated claim | ADR 056 (ingest half); traction-plan §17 (Exploring Next as the feed) | Nothing | CC CX CU | after launch |
| 13 | **multi-agent-tax** | The measurement recipe: two agents, one repo, same feature, count the wasted work (thrown-away diffs, undone changes) with and without lane ownership; report the honest denominator | ADR 122/123; wiki `cookoff`; `lanes-and-the-multi-agent-tax.md` | The uncoordinated arm is easy; the coordinated arm *is* the product — the skill ships the measurement, and the number the reader gets is their own | CC | after launch |

Twelve after the first, at 3–4 days each: four by Oct 5, eight by Oct 25, the rest after launch.
Skills 5–9 are the ones a stranger keeps; 10–13 are for the team that has already kept one.

## 4. What does not travel (and why the README says so)

These are the product, and every skill's doorway line names one of them:

- **Identity that outlives sessions** — a seat is a durable member, not a chat; a file cannot be
  a member.
- **Presence and delivery** — who is here, where an act landed, that it was read.
- **Attestation a second party can check** — which model actually did the work, observed by the
  harness rather than declared by the model (ADR 158/163/187). *Narrowed 2026-09-19 (ryder):* the
  **checking** is the product; the **classification** travels — observed > environment > declared,
  the tier carried beside the value, and "absence is not an assertion" (ADR 301/383/173). See §6
  strengthener for skill 2.
- **The gate at claim time** — one owner per surface enforced, not agreed.
- **The record** — silence, lateness, a decline, an unanswered ask, a close without a second
  claim, all as audit rows with a name on them.

## 5. Sequencing notes

- Skill 1 is repo-and-publish work, not authoring; it is first because it exists.
- Skills 2–4 are the plan's four; their lanes are open (`01M2PAMFW1`, `01M2PAMQX5`, `01M2PAN1F0`,
  `01M2PANKGP`). Skills 5–13 get lanes as their turn comes, one at a time, so the board never shows
  more skills in flight than seats building them.
- The e2e walk that produced this list is the rendered guidance's section list, the
  practice-deciding ADRs, and `docs/wiki/`. Anything found later that qualifies is appended here
  with a date, not slotted silently.
- Every README is reviewed by product-communications before publish (one story on every surface);
  every skill's SKILL.md is reviewed by a seat of a different model family than its author, which
  is skill 2 applied to itself.

## 6. Full-project sweep (2026-09-19, ryder, lane `01M2XEB0N3`) — appended per §5

nick asked for a wider sweep before any of the four planned skills is built: the whole project —
code, scripts, harness integration, research, and concepts adopted while building across many
harnesses and models — not only the three sources §5 names. Three read-only sweeps ran in parallel
(code + scripts + hooks · design docs + ADRs + wiki · research + harness lore); ~60 raw candidates
were curated into what follows. Two decisions from nick, 2026-09-19, shape it: **catalogue only, no
ranking** — the order is his and product-communications' to set; and **scope is coordination +
epistemics** — general-engineering practice adopted along the way is recorded under §6.4 so the
coverage is visible, not proposed.

**The headline, from two sweeps independently:** §3 found the *loop* practices — claim, inbox, ask,
close, orient — and almost entirely missed the *epistemics* family: how this team decides whether it
is allowed to believe something. `docs/claims/`, `docs/controls/`, `docs/watches/`, the wiki trap
catalogue, and ADRs 052 / 247 / 294 / 297 are that family. None of it needs a daemon, and it is the
most transferable material in the repo.

Qualification is §1's, unchanged. Cost is at the 3–4-day cadence. ★ marks a candidate that the
relevant sweeps converged on independently.

*Names reviewed 2026-09-19 (sloane, lane `01M2XERV15`), per §5's product-communications read.*
Three changed, each for a reason rather than taste. **B1 `believe-it-or-not` → `dated-and-falsifiable`:**
a borrowed phrase reads as a joke, brand.md §7 spends the personality budget elsewhere, and it was
the one name that did not say what you do. **B4 `docs-that-cannot-drift` → `docs-that-catch-drift`:**
docs can drift and checkers narrow where — B4's own body says the honest version ("checker, not
generator"), and a `cannot` sitting one row under a bundle about instruments that lie is what a
stranger notices first. **S4 `seat-worktree-identity` → `seat-workspace-identity`:** `worktree` is
one of the four words ADR 296 lints outright; the git literals in its body are flags and stay. That
last one was invisible to `vocab:check`, which gated this directory on the work-item table alone —
fixed in the same commit.

### 6.1 Bundles

| # | Skill | The practice, in one line | Source | Cannot do without the daemon | Cost |
|---|---|---|---|---|---|
| B1 ★ | **dated-and-falsifiable** | A belief carries the date and the observation that would overturn it. Ten named ways a green check or a quiet instrument lies, each with a repair and a falsifier — shipped first as the idea, then three thin scripted instruments that open with the same paragraph: *controls-in-force* (every guard carries last-exercised **xor** a never-exercised reason, ever-tripped, and "would it have caught its own motivating incident?"), *pre-registered-watch* (a days-long measurement is a question with an owner and a death date; `revisit_by` immutable; `void: unattended` is a datum), *claims-ledger* (the corrector mints the entry at the moment of correction, riding an act they are already performing; no bare rates; self-catch scores best) | wiki `instrument-silence`, `the-instrument-discharges-the-act`, `silence-is-only-evidence-when-someone-was-listening`, `cannot-separate-two-causes`, `boundary-injection`, `correct-by-coincidence`, `uniform-error-is-invisible`, `double-gated-tests`, `controls-in-force`, `constraint-outlives-its-premise`, `recorded-not-routed`; `docs/controls/registry.ts` + `scripts/check-controls.ts`; ADR 297 + `scripts/watches.ts` + `scripts/check-watches.ts`; ADR 294 + `docs/claims/` + `scripts/check-claims.ts`; ADR 052 | Nothing — `claimant_model` is self-declared, not attested | 4d idea + 3 × 3d |
| B2 ★ | **hooks-that-reach-the-model** | For each harness: which event fires, what it can inject, whether the injection *reaches model context*, and which harnesses have no hook path — measured, with a falsifier per row. Plus the house style for any hook: fail-open always; `cd` to the project dir first; a versioned marker comment so an installer can find and replace its own lines; dual-format deny JSON so one script serves Claude Code and Cursor; Codex reads the git *common* dir so a Workspace's hooks silently never fire; Grok `PostToolUse` context does not reach the model but `PreToolUse` does. Ships a canary (write a known string from a hook, grep the transcript) | ADRs 249, 363, 198, 369, 370, 362, 392, 419, 333, 168, 088; `.claude/settings.local.json`, `.cursor/hooks.json`, `.codex/hooks.json`, `.grok/hooks/musterd.json`; `docs/harness-hooks.md`; wiki `driver-support-matrix`, `harness-statusline-seams`, the four `*-live-doorbell-eval` pages; `daemon-doorbell-contract.md` is harvested, not shipped | Nothing is *delivered* into the pipe — reachability can be proven, arrival of a real directed act cannot; nothing attests the hook ran | 5–6d |
| B3 ★ | **decision-records** | The whole decision lifecycle: take a number against *everything in flight* (local ∪ main ∪ open PRs, never by reading main; gaps legal) → publish it as a draft PR **before** writing → write → `## Decision` frozen on accept → amend only in Consequences, dated, append-only, checked → every agent-facing decision names Traces / Eval / Experiment with a baseline or an explicit `n/a` → every "later" sentence carries `Follows-up: <id \| deferred — trigger (date) \| none — why (date)>` and silence is the one shape refused → the deviation protocol (a judgment call means stop, write the record, smallest correct change, doc in the same commit). **Absorbs skill 9.** | ADRs 220, 223, 052, 373, 284; `scripts/adr-next.ts`, `check-adr-numbers.ts`, `check-obs-evals.ts`, `check-intents.ts` + `intents-corpus.ts`, `check-change-adr.ts`, `adr-sections.ts` / `adr-status.ts`; `scripts/decision-restore.test.ts` + `rename-tracking.test.ts` (real-git tests — a `git mv` took a whole rule off); AGENTS.md deviation protocol; `07-conventions.md` §ADRs | Nothing | 4–5d |
| B4 ★ | **docs-that-catch-drift** | One doc, one job, one lifecycle; one fact, one home; docs and code never disagree at the end of a commit; the four anti-patterns that make docs stale. "Checker, not generator": where structure is mechanical and prose is load-bearing, enforce the structure and refuse to generate the prose. Instruments: drift-checked file trees; a roadmap generated from a typed data module and then anchored to git history; guidance may duplicate command *names* only and every name must exist; writer and checker read the same exported scope list; a claims gate that strips mentions before matching, because a gate that fails when you *document* it teaches you to document less | AGENTS.md §"Where each doc lives"; ADRs 043, 041, 085, 284, 320 §5a, 259; `check-arch-trees.ts`, `gen-roadmap.ts` + `check-roadmap-truth.ts` + `content/roadmap.data.ts`, `check-guidance.ts`, `format-scope.ts`, `check-claims.ts`, `wiki-coverage.ts` (measure a denylist's recall on a labelled corpus) | Nothing | 4–5d |
| B5 | **measure-agents-honestly** | A pre-registered run manifest (pin model, harness version, kickoff SHA, predicate set, allowlist before the run; a frozen ruler must not bend to fit the result; a predicate change is a new versioned set disclosed before the runs it scores); wasted-work archaeology from git alone (a surviving reimplementation is not waste); diagnostic-not-ranking (never rank members; every rate carries its channel and denominator; one headline, supports, and a guardrail — never a single score); zero-spend retro (audit the logs you already have, with a pre-registered rule for whether the paid run is still needed). **Absorbs skill 13**, and carries the line its row lacks: *the sell is D-vs-uncoordinated-N, never D-vs-solo — solo wins cost and wall-clock, D burns ~7.7× solo's tokens.* | ADRs 122, 123, 052, 056, 194; `cookoff-run-manifest.md`, `cookoff-cell-runbook.md`, `cookoff-measurement.md`, `cookoff-scenario-repo.md`; wiki `cookoff`; `human-agent-dynamics.md` §4; findings 002, 007, 009, 011 | The coordinated arm *is* the product; the number a reader gets is their own | 5–6d |
| B6 | **the-team-agreement** | The charter layer above skills 3 and 7: the human is a member, not an approver; name stances (supervising / pairing / delegating / deferring) rather than storing an autonomy level; notification is the mechanism; roles are aptitude, not authority (a charter plus a ceiling, narrow-only, optional; admin is not a role); write work stays in your seat — never a subagent that edits, claims, or commits, while read-only fan-out is fine because knowledge needs no provenance | `human-agent-dynamics.md` §1 / §2 / §5; `human-role-reevaluation.md`; ADRs 145, 227, 272, 163, 109, 150; AGENTS.md hard rule 8; Co-Gym (arXiv 2412.15701) notification ablation 30% → 70% | Nothing routes an ask to a human who is actually present; a subagent spawn can be refused but not recorded | 2–3d |

### 6.2 Singles

| # | Skill | The practice, in one line | Source | Cannot do without the daemon | Cost |
|---|---|---|---|---|---|
| S1 ★ | **skill-home-and-provenance** | One canonical harness-neutral `.agents/skills/<name>/SKILL.md`; thin bridges in `.claude/`, `.cursor/rules/*.mdc`, and an AGENTS.md pointer for Codex — never a copy; adapted material carries `PROVENANCE.md` (URL, reviewed SHA, license, what was taken) + `LICENSES/`. The substrate the `musterd-skills` repo needs anyway, and it closes §2's open item | ADR 299; `.agents/skills/product-communications/{SKILL.md,PROVENANCE.md,LICENSES/}`; ADR 085 | Nothing | 2–3d |
| S2 | **extraction-guarantee** | If you claim a package is liftable into its own repo, make it a test: no source file imports `@yourscope/*`, `package.json` declares no internal dependency. Forty lines of vitest. Ships **with skill 1** as the proof it travels | `packages/whiteboard/src/extraction.test.ts`; ADR 330 decision 1 | Nothing | 1h |
| S3 | **a-finding-is-not-a-fix-request** | A review finding is REQUIRED only if the spec would have demanded it before the diff was opened — honesty, a leaked secret, a probe-measured regression, a named pin; everything else is a note, and a decline names the category the finding failed. "Complying is the failure mode." Pairs with **skill 2** | ADR 338; `.github/REVIEW-RULES.md`; wiki `adr-338-drift-rerun` | A noted finding has no board to land on under the finder's name | 2–3d |
| S4 | **seat-workspace-identity** | One Workspace per agent, each with its own git identity: `git config extensions.worktreeConfig true`, then `--worktree user.name` / `user.email` — without the extension, repo-local config is shared and the last-provisioned seat silently renames every other seat's commits; the `Co-authored-by` trailer is what survives the squash | ADRs 109, 368; wiki `which-seat-the-cli-acts-as`; `cookoff-cell-runbook.md` traps | The identity is a label, not an attested member; nothing stops two sessions in one Workspace | 2–3d |
| S5 | **two-consumers** | Before adding a consumer to a shared value, ask both clauses — what wrote this row, and who else reads it? A documented discard is a precondition on its consumers, not an implementation note: "the documentation terminates the investigation". And: absent is unknown — never zero, never a guess; an abstention is counted, not left indistinguishable from a legacy row | ADRs 247, 225, 173, 417 §1–3, 383; `07-conventions.md` §"Shared values and transforms" | Nothing | 2–3d |
| S6 | **definition-of-done** | Eight clauses where docs, traces and an eval are peers of tests; landed means squash-merged with the one required gate green, never a direct push; **done is two claims, not one**. Merge verification is a script with no daemon — `git merge-base --is-ancestor <sha> origin/main` after a best-effort fetch, with tiered outcomes (`ancestor` / `not_ancestor` / `unknown_object` / `fetch_failed`) and refusal on positive evidence only. **Absorbs skill 8** | `07-conventions.md` §Definition of done; ADRs 052, 106, 300, 192; wiki `shipping-a-pr`, `running-the-gates` | Nobody records that you claimed done, and no second party claims it back | 1–2d |
| S7 | **emitted-is-not-published** | Storing a teammate's prose so their teammates can read it is the product; publishing it is a separate act with its own permission. Structural fields ship pseudonymised per release; prose bodies are omitted by default; **deliberately not a scrubber** — regex PII-stripping over free prose gives false safety; the provisioning human's consent does not cover agent-seat prose | ADRs 184, 173, 280 | Nothing — it is a posture | 2–3d |
| S8 | **capture-rough-explore-once** | Capture the raw idea verbatim with deterministic cleanup only — no reasoning, no tagging, no dedup at capture time ("a seed that arrives pre-judged is a lane someone has to argue with instead of edit"); then one explorer, one decision-blocking question at a time answerable only by the submitter, one exhaustive brief that becomes an ordinary unowned work item | ADRs 248, 291, 311, 312, 318, 319 | No always-on capture channel; nothing enforces one explorer at a time | 3–4d |
| S9 | **mast-checklist** | Read a multi-agent transcript against the MAST failure taxonomy — ignored `request_help`, circular handoffs, stalled threads, broadcast-only journaling — plus Co-Gym's human-loop classes; the worked example is your own last session. Cites the papers | ADRs 056, 050; `research-foundation.md`; MAST (arXiv 2503.13657), Co-Gym (arXiv 2412.15701); finding 002 — "and it caught us" | On a raw transcript it is a human read, not a metric | 3d |

*Shipped 2026-09-21 (dolly):* S1 `skill-home-and-provenance` (lane `01M32JZHGG`, #1604) and
S6 `definition-of-done` (lane `01M32K99CR`) are built and live at `.agents/skills/<name>/`. S6
ships `landed.sh` — ADR 300's verification as a daemon-free script, all five tiers exercised
against real repositories including `not_ancestor` in a scratch repo. Per §6.3, S6 absorbs §3
skill 8; that row should not also be built.

*B1 increment 1 shipped 2026-09-21 (dolly, lane `01M32JXEK8`):* the **idea** half of B1 —
`.agents/skills/dated-and-falsifiable/SKILL.md`. The three scripted instruments
(controls-in-force, pre-registered-watch, claims-ledger) are increments 2–4 of the same lane,
matching the row's own `4d idea + 3 × 3d` shape. Two dated notes on the row as
written. **It is twelve shapes, not ten:** the eleven sourced wiki pages yield twelve distinct
failure modes once *the instrument discharges the act* (a destructive read) and *recorded, not
routed* (a distribution failure) are kept separate from the aliasing family, and collapsing any of
them would have merged causes the pages exist to tell apart. **The catalogue's own anecdotes are
deliberately undated** — they illustrate a shape for a stranger who cannot run our falsifiers, and
the skill says so rather than hoping the reader does not notice; the two that *are* checkable
anywhere (the zsh glob abort, the pipeline exit code) were re-run on 2026-09-21 under zsh 5.9
before publishing.

*B1 increment 2 shipped 2026-09-21 (dolly, same lane):* `controls-in-force` — the registry
convention plus `controls.py`, a stdlib-only Python checker carrying the repo's own rules
(exercised **xor** never, a dated absence, real non-future dates, tripped ⟺ dated, the
counterfactual answered, and staleness that ages a declared absence against the same bound). All
**eighteen** refusals were fired against the shipped script before publishing, not read. Two
things worth carrying forward. **Python 3 stdlib, not shell:** S6's `landed.sh` could be POSIX
shell because it shells out to git; a JSON registry cannot be parsed in portable shell without
`jq`, so the honest dependency is `python3` and the skill names it. **The first falsifier run
reported 17 of 18** — the aged-absence row passed because the example's declared absence started
that same day, so the fixture could not construct the failure it was named for; re-run against an
aged date it fires at 263 days. That is B1's own item 4 caught inside the instrument that ships
it, and it is written into the skill as a worked example rather than quietly fixed.

*B1 increment 3 shipped 2026-09-21 (dolly, same lane):* `pre-registered-watch` — ADR 297's
primitive as a standalone gate. `watches.py` (stdlib-only, hand-parsed frontmatter per ADR 002's
reasoning) carries the schema, rule A1 (no open watch outlives its `revisit_by`) as a tree check
and rule A2 (`revisit_by` is immutable) as a diff check behind `--base`. Thirteen refusals and
four must-NOT-fire cases exercised, the git rules in a scratch repo with real commits. Two
carry-forwards. **A2 abstains rather than passing:** `--base` absent prints `immutability NOT
checked`, and a `--base` git cannot resolve prints `UNKNOWN … Not a pass` at exit 0 — a check that
reports clean from its own outage is the failure the parent skill is about, so the shape is S6's
refuse-on-positive-evidence-only applied to a second gate. **Third increment running, third
first-run falsifier failure that was the fixture and not the code:** three rows did not fire, two
because they aged `revisit_by` while leaving `opened` at today so the schema rule fired first and
A1 was never reached. Written into the skill as its own section — when a rule does not fire, the
fixture is the likelier culprit, and from the outside the two are indistinguishable.

*B1 increment 4 shipped 2026-09-21 (dolly, same lane) — B1 complete:* `claims-ledger`, ADR 294 as
a standalone instrument. `claims.py` validates the entry schema and ships `--cut`, which prints
**counts and never a percentage**, with the denominator caveat attached to every run — decision 4's
"no bare rates, ever" made structural rather than cultural. Fifteen refusals and five
must-NOT-fire cases exercised; every row fired first time, and the skill says why rather than
claiming improvement (this schema has one cross-field ordering rule, where increment 3's had a rule
that shadowed the one under test). **One correction to the row as written:** §6.1 B1 cites
`scripts/check-claims.ts` as a source, and that script is the ADR 320 naming-claim gate — it has
nothing to do with the ledger and belongs to **B4**'s row, which already names it correctly ("a
claims gate that strips mentions before matching"). The ledger has 27 entries and had **no**
validator, so `claims.py` is new work rather than a port; B1's cost line was estimated on the
assumption that one existed.

*B2 shipped 2026-09-21 (dolly, lane `01M32JY65H`):* `hooks-that-reach-the-model`. The row's
central distinction is the skill's opening: **a hook that RAN and a hook whose output the model SAW
are different facts**, and harnesses answer the first loudly and the second not at all. Ships the
per-harness reachability table with a falsifier per row, the six house-style rules (fail open; `cd`
first; a versioned marker so an installer can find and replace its own lines; both JSON dialects in
one emit; self-gate; keep it short), the two measured traps the row names (the git **common-dir**
resolution that makes a `git worktree`'s hook file silently unread; neighbouring events disagreeing
inside one harness), and `canary.py`.

Three things worth carrying. **The table is framed as a worked example, not as current truth** —
these are other seats' dated measurements on specific harness versions, restated, and the canary is
how a reader gets their own; claiming the table as live fact would be exactly the shape B1 item 10
catches. **The canary refuses on positive evidence only**, the S6/`landed.sh` rule now applied to a
third gate: a sentinel under an unrecognised key is `CANNOT TELL`, never `DID NOT REACH`. **That
was a real defect the first version shipped with** — unrecognised key, unstructured plain text and
genuine absence all returned the accusing verdict, three causes on one reading (B1 item 3, inside
the instrument). Found by running the check against a fixture with a made-up key and noticing the
verdict was more confident than the evidence. All eight verdicts exercised after the fix.

A second self-inflicted instance, recorded because it is the funnier one: the first exit-code
measurement was taken through `| tail -6`, which returned 0 for every case — B1 item 2, the pipe
that discards the upstream exit code, committed while measuring a skill about instruments that
lie.

*B3 shipped 2026-09-21 (dolly, lane `01M32JYHEV`) — the last ★ row:* `decision-records`, absorbing
§3 skill 9 per §6.3, so that row must not also be built. Ships the five lifecycle rules (take a
number against everything in flight; publish it before writing; `## Decision` frozen on accept with
dated append-only amendments; name what would tell you it was wrong, or a reasoned `n/a`; a
promise names its disposition and silence is the one shape refused), the deviation protocol, and
`adr.py next` / `adr.py check`.

Three things worth carrying. **The rename lesson is sharper than the repo tells it.** Measured on
git 2.51: rename detection is ON by default, so a plain diff does report the rename — the delete+add
shape appears under `diff.renames=false`, `--no-renames`, or an older git. So the honest rule is not
"git reports a rename as delete plus add" but **rename detection is a configurable default, so a
rule relying on it works on your machine and comes off silently in a repo that turned it off**. The
script passes `-M` explicitly and was verified to still refuse under `diff.renames=false`. The
wiki's framing is not wrong about the incident, only about the mechanism; nothing needs correcting
there, but B3's body states the measured version.

**Two real defects, both found by running it.** `next` matched the `NNN-slug` shape against every
file in an open PR, and a dated name has that shape — on this repo it answered **2027** instead of
433. The first fix (scope to the records directory) **passed only by coincidence**, because
`docs/decisions/` happens to hold no dated files; putting one there brought 2027 straight back. Both
guards are needed. Written into the skill as the worked example of *a fix verified only against the
case that produced the bug is a fix verified against one sample*.

**Cross-checked against the reference implementation:** `adr.py next` and `pnpm adr:next` both
answer 433 on this repo with its real open PRs. Thirteen falsifier rows exercised against scratch
git repositories.

*B6 shipped 2026-09-21 (dolly, lane `01M32K81AT`):* `the-team-agreement` — the charter layer, and
per §6.3 the preface §3 skill 7 (`ask-a-human`) wants, so sequence it before that row. Five
commitments (the human is a member who sometimes wears an approver hat; stances not stored autonomy
levels; notification is the mechanism; roles are aptitude with a narrow-only ceiling, and approver
is not a role; write work stays with whoever is accountable), plus a five-question adoption audit
whose answers are observable — the falsifier for a charter that has no checker.

**One correction, and it is the point of the increment.** The row and
`research-foundation.md` §19 both carry Co-Gym's notification ablation as 30% → 70%, with 99
participants and 150 trajectories. Checking the citation before publishing under our name: the
paper, title and author list verify exactly, and **those numbers are not in the abstract**, whose
headline figures are different (86% / 74% / 66% win rates per task against real users). I did not
read the body to confirm the ablation. So the skill leads with the three verified numbers, states
the ablation explicitly as our second-hand reading rather than a citation, and says so in a named
paragraph. The persona study verified exactly as stated (162 roles, 4 LLM families, 2,410 factual
questions, no improvement, picking a good persona no better than random).

Nothing in `research-foundation.md` needs correcting on this evidence — an abstract not carrying a
body result is not a contradiction. What it needs is someone to read the body once and either
confirm the ablation or invalidate-date it; recorded here rather than left as a silent assumption
by anyone who cites it next. **Follows-up:** deferred — the next seat that needs the ablation as
load-bearing evidence reads the body (2026-09-21).

*B5 shipped 2026-09-21 (dolly, lane `01M32K7QXT`) — absorbs §3 skill 13, so that row must not also
be built.* Five habits (pre-register the manifest and freeze it; reconstruct wasted work from git
alone with the two exclusions that cost most — a surviving reimplementation is not waste, self-rework
never is; diagnose rather than rank; the denominator; the zero-spend retro first, with the
necessity rule written down in advance) plus `manifest.py check|freeze|verify`.

**The denominator line ships verbatim, and it is the one that costs us our best number.** Solo:
0% waste, full acceptance, ~24k output tokens; coordinated N ≈7.7× that and slower at this scale —
so the comparison is coordinated-N against *uncoordinated*-N, never against solo, and anyone quoting
a multiplier against a solo baseline is answering a question nobody asked. That unflattering number
is published; the flattering one is not.

**The 38× is deliberately absent from the skill**, matching `cfp-abstract.md`'s own gate rather than
re-deciding it: the flagship is ~994 commits old (lane `01M1VDRC6B` is the re-run), and the skill
says why a gated number is gated instead of quietly omitting it. The posture it teaches is that the
reader's number should be their own — a multiplier from someone else's repo on someone else's build
is decoration.

`manifest.py` makes "a frozen ruler must not bend" checkable: `freeze` records a canonical hash and
refuses a manifest failing `check`, `verify` separates **never frozen** from **changed**, and the
hash is over canonical JSON so reordering or reindenting the file does not trip it — a check that
fails when you tidy a file teaches people to stop tidying it. Its honest limit is stated in the
body: the freeze file is written by the same person on the same machine and defeats drift, not a
determined author; publish the hash somewhere you do not control. 16 refusals and 6 must-NOT-fire
cases exercised, all passing first run.

*B4 shipped 2026-09-21 (dolly, lane `01M32JZ2AB`) — the last bundle:* `docs-that-catch-drift`,
keeping sloane's honest name (docs CAN drift; a checker only narrows where). Ships the four
anti-patterns, one-fact-one-home, docs-and-code-agree-at-the-end-of-a-commit, the four
instruments with the rule each taught, mentions-are-not-uses, and `tree-check.py` — the
checker-not-generator instrument, **deliberately with no `--fix`**, because a generated
description reads as documentation and says nothing, which is worse than an empty section: an
empty section invites a reader and a filled one stops them.

**The bug it shipped with is this row's own subject, and it is the best finding of the arc.** The
first version **refused its own SKILL.md**: the `## File tree` heading inside the fenced *example*
is a MENTION, not a use, and the checker read it as a real tree. That is the exact trap the skill's
own "mentions are not uses" section warns about, committed inside the file writing the warning —
and had it shipped, the first thing any adopter would learn is to stop putting examples in their
docs, which is the "a gate that fails when you document it" failure stated precisely. Fixed by
masking fenced regions before scanning for headings, with length-aware nesting so a longer fence may
contain shorter ones. **The cheap general test is now written into the skill: run a text gate against
its own documentation** — any gate whose docs must quote what it matches has this bug until proven
otherwise, and its own page is the shortest path to proving it.

Eleven falsifier rows exercised, including the abstentions: an odd fence count and a run that found
no blocks both exit 2 with "nothing was checked — that is not a pass", never a cheerful zero.

### 6.3 Strengtheners for §3 (fold into those rows when each ships)

| §3 skill | Add |
|---|---|
| 1 agent-whiteboard | S2 as the proof it travels; ADR 378's huddle as its facilitation chapter — an anchor naming where the output lands, a recorder, one artifact out, clauses recorded as exempt rather than scored |
| 2 cross-family-review | ADR 314 / 172 as the *why* and the counting rules (family from live attestation, never the seat name; an `unknown` agent is out of the denominator; humans ride beside the posture, never inside it); ADR 181 — the reviewer reads whole files, not a diff keyhole; ADR 303 — an auditable selection snapshot; S3 paired; the attestation classification vocabulary as the doorway paragraph |
| 3 board-loop | ADR 256 / 258 goal layer — a `story` ≤ 140 chars for an outsider, shipped goals carry an outcome line, retraction is a signal not a deletion; ADR 288 / 233 — review debt is a board fact and `owed_reviews` renders first; ADR 240 — a lane title is correctable; "declare stakes at submit — forgetting must cost an ask, never a review" |
| 4 harness-inbox | ADR 211 — a deferred act raises on a condition, never a clock; ADRs 287 / 290 / 349 — the cursor never passes what you did not see and walks receipt order; ADR 254 eligible sets named as the doorway |
| 5 wiki-claims | B1's rule-3-as-reviewing-discipline, cross-linked; `scripts/wiki-probe.ts` — score re-derivation against the corpus you *started* with; the honest self-indictment: a green run means "no claim in a named shape is undated", never "every defect claim is dated", with the shortfall measured in `defect-gate-coverage.md` |
| 6 orient-and-remember | ADR 093's concrete shape — headline ≤ 120 chars, body ≤ 8 KB, one blob, last-write-wins, "stores, never composes"; **ADR 326's tier-1 / tier-2 split** — handle what is addressed to you unprompted, merely surface the rest — is the actual skill |
| 7 ask-a-human | ADR 153 "strand, don't stall"; ADR 145's two invariants (escalations always technically reach; nothing below top tier can wedge); ADR 250 — route to an actor or mark the move unverified, nothing between; B6 as preface |
| 8 merge-on-the-word | → absorbed into S6; ADR 300's verification script is the sharpest shippable thing in it and the row does not name it |
| 9 adr-amendments | → absorbed into B3 |
| 10 one-meaning-per-word | ADR 098's work-item vocabulary as a second table; mention-vs-use via backticks; ADR 296's amended gate philosophy — lint only words with no legitimate second sense, hold the rest in review — is the rule that makes a vocab linter survivable |
| 11 shared-red | `scripts/lib/shared-blocker-notice.mjs` — measured: the norm in the skill body produced zero reports, ever; **the gate teaches**, at zero context cost, and prints the canonical cluster string `ci:<job>/<step>` |
| 12 research-radar | `scripts/radar/` is more complete than the plan implies (fetch, dedup, two-tier triage, digest; print-only by default); a paper-adoption ledger as its output artifact; ADR 194's produce loop and ADR 056's honest-N discipline |
| 13 multi-agent-tax | → absorbed into B5, with the denominator line |

### 6.4 Recorded, not proposed

**General-engineering practice adopted along the way — out of scope by nick's 2026-09-19 decision,
listed so the coverage is visible:** *build-and-release-integrity* (ADRs 135, 267, 195, 156, 216,
106 — a `dist/build.json` stamp with three staleness signals; migrations strictly ascending, or a
duplicate version is never applied, silently, forever; a literal NUL makes ripgrep return silence for
a whole file; `.dockerignore` drift that shipped a live credential world-readable; pack and install
into a clean directory outside the workspace before the first registry write; per-package vitest
config inherits nothing from root; a spend gate opened by two env vars; one stable required-check
name fanning in over parallel leaves); *budgets-with-a-ledger* (ADRs 151, 183, 212 — the budget
file's `$comment` is an append-only ledger of every raise with its measurement and rejected
alternative; **a re-baseline may only tighten**; agent-context bytes as a second instance; a CSS
phantom-token detector); *contrast-is-measured-not-computed* and *pixel-parity-gate* (web craft).

**Coordination-adjacent but thinner, or borderline product:** *gate-dont-advise* (ADR 150 —
a PreToolUse deny with a repair string; Gate A needs a board, Gate B can block but not route);
*the-steward* (ADR 112 — a scheduled read-only drift scan that may only propose; the scan / act
split); *snapshot-before-you-build-on-it* (ADR 280 — `VACUUM INTO`, a drilled restore, uploads
nothing); *honest-numbers-readout* (`scripts/traction.ts` — "not measured" never prints as zero);
*label-your-windows* (ADRs 160, 418 — the OSC-0 grammar); *prove-it-or-cut-it*
(`.agents/skills/product-communications/SKILL.md` de-musterd'd — "a bar that bends to an argument is
not a bar"); *orphan-sidecar-probe* (`scripts/perf/seat-footprint.mjs`); the *guidance-epoch* stamp
(ADRs 417, 148 — the portable sub-rules are in S5; the fleet census is product).

**Considered and does not travel** (beyond §4): the PreToolUse gate mechanism itself (server-side
atomic adjudication); the session-labeling engine (it resolves a seat); eligible sets; the
feature-epoch and guidance-epoch *mechanisms*; attestation *checking*; wakes, residency, leases, the
wake pool; presence, quiescence, posture; federation, sync, hub relocation; acceptance routing,
backstop, stakes; the doorbell contract itself; `heal-probe-rig/`; broadcast and stream infra;
daemon-internal benches; corpus and dataset export (schema-bound — ~1 week to lift); the
`scripts/research/adr-*` one-offs; the scenario tests; `packages/telemetry`; deploy artifacts;
office, canvas, motion and web-perf wiki pages (off-brand); laptop-specific wiki pages;
`agents-doing-research.md` (self-declared re-derive-before-use); the ontology as a skill; the
frontier-cadence manifest (never run); Track B.
