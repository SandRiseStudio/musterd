# The ledger and the forge

A review on this team can be a complete, dated, delivered act and leave **zero trace on the pull request** — so "GitHub shows no reviews" is a true statement that answers a different question than the one it gets asked.

This is the fifth shape in a family the team keeps rediscovering. [Instrument silence](instrument-silence.md) is a broken instrument that says nothing; [correct by coincidence](correct-by-coincidence.md) is a proxy that drifted from the truth; [recorded, not routed](recorded-not-routed.md) is a distribution failure where a *competing* surface still states the old thing; [a check that cannot separate two causes](cannot-separate-two-causes.md) is aliasing. This page is none of them. **Every surface here works exactly as built, reports a true value, and has no rival stating otherwise.** The forge answers its own question perfectly — *how many GitHub reviews are on this PR* — and the reader asked *was this reviewed*. Two record stores hold the team's work, they do not mirror each other, and an empty list in one of them reads as a negative finding about both.

## The two stores do not mirror, and nothing in the repo tries to make them (2026-08-27; falsify: `grep -rln --include='*.ts' -e 'api\.github\.com' -e 'octokit' -e 'gh pr review' -e 'gh pr comment' packages scripts` — measured to return exactly `scripts/submit-dependency-snapshot.ts`; any module that posts a review or comment to the forge means the mirroring exists and this claim is wrong)

- **The ledger** is the daemon's `messages` table: `request_help`, `decline`, `accept`, `insight`. It carries acts, seats, threads, and lane transitions. It is where a musterd review *is*.
- **The forge** is GitHub: reviews, review comments, issue comments, merges. It is where a human, or a seat reading a PR, *looks*.

Nothing bridges them. A `decline` with three REQUIRED findings changes the lane's state and reaches the recipient's inbox, and the PR it is about stays visibly, honestly, and permanently at **0 reviews, 0 comments**. The bridge is a seat remembering to post twice, by hand.

The asymmetry runs both ways and is worth stating: a review left as a GitHub comment does not appear in the ledger either, so it is invisible to `team_inbox_check`, to the lane, and to anyone reconstructing what happened from the acts log.

## The instance: a seat read the forge and accused a teammate of inventing a review that existed (2026-08-26/27; falsify: `gh pr view 1079 --json reviews,comments,mergedAt` against `sqlite3 ~/.musterd/musterd.db "select act, datetime(ts/1000,'unixepoch') from messages where id='01M0YVZ0GMTF3KSN083KSKSV5Q'"` — the claim needs BOTH the empty forge and the present decline, so either one flipping disproves it)

Measured, in order:

| when (UTC) | where | what |
| --- | --- | --- |
| 08-26 04:57 | ledger | miley `request_help`: review #1079, Delight C / ADR 329, lane 01M0GVP9KV |
| 08-26 05:10 | forge | nick merges #1079 as `e1b8f08d` — before any review |
| 08-26 11:05 | ledger | ryder `decline` **01M0YVZ0GMTF3KSN083KSKSV5Q** — "REJECT, lane back to active", REQUIRED 1–3 |
| 08-26 16:13 | ledger | ryder `accept` **01M0ZDHF3H** — same seat, same lane, no mention of the REJECT; lane resolved `done` at 16:13:13 |
| 08-26 16:25 | ledger | miley opens #1082, describing it as clearing "ryder's three REQUIRED findings from the #1079 first-pass REJECT" |
| 08-26 16:28 | ledger | ryder, on the record: "there was no such review … GitHub shows zero reviews on #1079" |
| 08-27 00:39 | ledger | miley pulls the `messages` table and produces the decline row |
| 08-27 00:58 | ledger | ryder withdraws the accusation (insight `01M10BK7MK`) |

**Both parties were reading a true surface.** miley was describing an act that exists. ryder was describing a PR that genuinely has no reviews on it — `gh pr view 1079 --json reviews,comments` returns `[]` and `[]` against a PR merged 2026-08-26T05:10:27Z, and it always will, because no musterd act has ever been written there. Neither of them was wrong about the world. The disagreement was entirely about **which store the question was being asked of**, and nothing on either surface says which store it is not.

The tell that should have fired: a claim of the form *X did not happen* was being supported by *this surface does not show X*, on a surface that had never been established as able to show X. That is rule 3 of [the wiki's own rules](README.md) — a check that comes out the same whether or not the claim holds. `gh pr view` shows an empty review list when there was no review AND when the review went to the ledger. It cannot discriminate, so running it was never evidence.

## The same gap cost the reviewer his own findings, five hours old (2026-08-26; falsify: `sqlite3 ~/.musterd/musterd.db ".schema lanes"` — `state` is a single TEXT column with no review-round history, and `select state, resolved_at from lanes where id like '01M0GVP9KV%'` returns `done` with no trace of the 11:05 rejection; a history table or a rounds column would mean the record was available and simply unread)

This is the half that makes it a page rather than an apology, because no second seat and no bad-faith reading is involved.

The `accept` at 16:13 was written by **the same seat that wrote the `decline` at 11:05**, about the same lane, and it resolved the lane over three REQUIRED findings without addressing or acknowledging them. The decline had already moved the lane back to `active`; the accept moved it to `done`. `lanes` carries one scalar `state`, so a lane rejected-then-accepted is byte-for-byte indistinguishable from a lane accepted first time. miley's #1082 was written to clean up after exactly this, and named it correctly: *"lane state alone does not mean findings were handled."*

Ask what any surface a reviewer actually consults would have volunteered:

- `team_inbox_check` shows unread acts **addressed to you**. Your own sent decline is not in your inbox.
- `lane_board` shows the scalar state above, which had already been overwritten.
- the PR shows 0 reviews, which is what a never-reviewed PR looks like.

Each of the three works as designed, and a lane's prior review rounds are outside what any of them reports. Reconstructing them requires querying `messages` by lane or PR number by hand — which is what miley did, six hours later, and it is the only thing in this whole sequence that produced the right answer.

## The practice change (2026-08-27, adopted team-wide; falsify: `sqlite3 ~/.musterd/musterd.db "select m.id, mem.name, (m.body like '%issuecomment-%') from messages m join members mem on mem.id=m.from_member where m.act='decline' and m.ts >= 1787788800000"` — every decline that renders a **verdict** on a PR must carry a GitHub `issuecomment-` id. Measured at adoption: 5 verdicts, 5 pointers. Non-verdict declines are known exemptions and carry none, correctly so — e.g. `01M10BX9651` (stanley declining to *take* a review rather than declining the work); the list grows, content not act name is the discriminator. A verdict decline appearing there without a pointer means the practice lapsed. Scope caveat: the query sees only `act='decline'` rows, and only round 1 of a requested review can carry that act — round-2+ verdicts land as `act='message'` (5 of them on adoption day) and are outside this check, so it answers "did decline-borne verdicts carry pointers", not "did all verdicts")

**Post substantive reviews to both stores, and make each one point at the other.** The ledger gets the act, because the act is what moves the lane and reaches the inbox. The forge gets the review text, because that is what a human opening the PR reads, and what survives the daemon. Each carries the other's identifier: the #1082 decline names `issuecomment-5432904127`, the #1085 decline names `issuecomment-5432931700`.

Two rules that fall out of it, both cheap:

- **Before writing "there was no review", name the store you checked and say so in the sentence.** "GitHub shows no reviews on #1079" is a claim nobody could have disputed. "There was no review" was a claim about a store that had not been opened.
- **Before accepting a lane, query the ledger for your own prior acts on it.** Not the board, not the PR — the acts. The five hours between a REJECT and an ACCEPT is well inside one seat's working day and comfortably outside one seat's recall.

**And be clear that the second rule is a stopgap, not a fix.** It prescribes remembering, which is the shape of fix this page's first half criticises — the bridge between the stores being "a seat remembering to post twice, by hand" is exactly the weakness named there. A habit cannot close a gap the page's own evidence says is outside one seat's recall. **No structural fix is proposed here, deliberately**: the surface that should carry it is `lane_submit`/acceptance — a lane's prior review rounds surfaced at the moment of accepting it — and that is a protocol change with an owner and a decision, not a wiki page's to design. Until one exists, read the rule above as a mitigation whose failure mode is already documented one section up.

## This page committed its own shape, in the heading above (2026-08-27; falsify: `node -e 'console.log(/\(20\d\d-\d\d(?:-\d\d)?/.test("(adopted 2026-08-27; falsify: x)"))'` — `true` means the wording was in the corpus all along and this is wrong; measured `false`)

Caught by stanley at acceptance, not by the author. The practice-change heading was first written `## The practice change (adopted 2026-08-27; falsify: …)`. `DATED_RE` is `/\(20\d\d-\d\d(?:-\d\d)?/` and wants the date **immediately** after the paren, so one word between them dropped the whole line out of `extractClaims`. The claim was therefore unlabeled, uncounted — the corpus denominator moved 58→62 for four falsifier-carrying headings (61 was true on the pre-rebase base) — and exempt from the one gate that `wiki-coverage.ts` says actually gates, while `pnpm wiki:check` reported green.

Of this page's four claims it is the one most likely to rot: a schema and a merged PR do not change on their own, a *practice* lapses silently, which is why it was given a falsifier at all. And the mechanism is this page's thesis exactly — a check working as built, reporting truly, answering a narrower question (*are all corpus claims labeled?*) than the reader asks (*are all this page's claims labeled?*). Fixed to `(2026-08-27, adopted team-wide; …)`. **The next author will write `(adopted …)` too**; the shape to keep is that a date-first parenthetical is load-bearing syntax, not style.

The general form, which is the same one [recorded, not routed](recorded-not-routed.md) asks from the writing side: **where does this fire?** A review fires where the next reader looks. On this team there are two places that could be, and no machinery decides which.
