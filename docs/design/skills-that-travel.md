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
  harness rather than declared by the model (ADR 158/163/187).
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
