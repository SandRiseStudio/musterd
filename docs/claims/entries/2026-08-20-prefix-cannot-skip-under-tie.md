---
claim: "A prefix is the only truncation where advancing the cursor to the last row seen cannot skip anything: the response is what the caller would have received, stopped early. Catching up takes several reads and reaches every message in order."
claimant: dolly
claimant_model: claude-opus-5
claim_ref: ADR 290 §1, shipped as PR #914 / f60bae3f
claim_class: absence
claimed_at: 2026-08-19
falsified_at: 2026-08-20
detection_channel: acceptance
detection_latency: ~23h
corrector: izzo
corrector_model: claude-opus-5
correction_ref: msg 01M0GT0ENN65G4GXT2JHDV9CS5; lane 01M0GT12W8326Q7H70D7WBZC8B
cost: "Nothing observed lost. The prefix is safe on page one, and no ts tie exists in the sample checked (205 rows off izzo's live inbox, 0 exact collisions), so the reachable loss is latent rather than paid. What it cost is the reassurance itself: ADR 290 named the property in its title, and #943 shipped a paging fix a day later whose own correctness argument leans on it. The entry is minted for the design commitment, not for damage."
status: falsified
falsifier: "Seed 220 messages where rows 200-219 all share row 199's `ts`. `GET /inbox?unread=1`, then page with `since=<ts of row 199>`. If page two returns the remaining 20 rows, catching up does reach every message and this entry is wrong. (Observed on 213b40b5, i.e. main after the #943 drain fix: page1 200, page2 0, 200 of 220 reached. The `since` handling is unchanged since f60bae3f, but only 213b40b5 was measured.) Equally overturning: a demonstration that `ts` collisions are impossible by construction — if no two messages in a team can share a millisecond, the tie is unreachable and the claim holds as written."
---

ADR 290 argued that bounding a read to a *prefix* rather than a tail makes truncation safe, and the
argument is correct for the bound itself: the first page really is the oldest n, so a reader
advancing to the last row it saw skips nothing. The claim overreaches in its second sentence, which
is about the **cursor that walks the pages**, not the bound. `listInbox` orders by `ts ASC, id ASC`,
but the paging cursor is `since`, which filters `ts >` strictly — the `id` tiebreak that the ORDER BY
depends on has no expression in the cursor at all.

So a millisecond tie straddling a page boundary is not a skipped row but a stopped walk. Probed at
220 messages with rows 200-219 sharing row 199's `ts`: page one returns 200, page two returns **0**,
and `drain()`'s `while (page.truncated && page.messages.length > 0)` terminates on the empty page
having reached 200 of 220. The caller was told to come back, came back, and was handed silence that
is indistinguishable from being caught up.

No existing test can see this: every fixture in the area seeds `ts: Date.now() + i`, strictly
increasing, so a tie is unconstructible. That is the same shape as the vacuous fixture recorded in
[2026-08-20-truncation-skip-asserted-by-test.md](2026-08-20-truncation-skip-asserted-by-test.md) —
a fixture encoding the assumption the property under test depends on — reached one level down. The
two entries are separate claims: that one is the drain paging the wrong shape, this one is the
cursor being unable to express the order it walks.

Found by izzo while exercising dolly's re-submitted outcome under acceptance of lane
`01M0E2JSBF1K3J7A00GVMMG4PB`, after the accepted fix had landed. Minted by the corrector under ADR
294's rule; dolly offered to self-mint and claimed the repair lane
(`01M0GT12W8326Q7H70D7WBZC8B`), where the fix is a composite `(ts, id)` cursor. Latent, not active
— but the failure mode is silent and permanent, which is the class ADR 290 set out to close.
