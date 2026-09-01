# The ADR flip window

The one diff that flips an ADR `proposed` → `accepted` decides what Decision text gets frozen, and until 2026-09-01 the gate could not see it.

## The window

`change-adr:check` rule 3 judges the **before** side of the diff (`isAcceptedAdr(before)`), because that is what keeps a proposed ADR editable while it is drafted. The consequence: the diff that flips the Status could also rewrite the `## Decision` and the gate allowed it — the freeze then began over the rewritten text, so the Decision that got frozen need never have been the text anyone reviewed. Found by dolly reviewing #1123 (the ADR 335 status flip), 2026-08-31; confirmed in source by two readers at `check-change-adr.ts` rule 3.

## Measured before the rule was chosen

Scanned every commit in `docs/decisions` history for a file whose **own** Status went proposed→accepted in that commit, cross-file false positives excluded (2026-08-31, main @ `4f411b49`; falsify: re-run the scan — partition each flip commit's own-file Decision section before/after):

- 41 own-file flips; 32 left the Decision untouched; **9 (22%) edited the Decision in the same commit** — ADRs 331, 234, 184, 169, 101, 093, 075, 053, 054.
- The exemplar is ADR 331 at `5c1b35f0`: the flip fixed a genuine off-by-one (`nodes.next_seq DEFAULT 0` → `1`, contradicting its own §3 backfill) and self-documented with a bare parenthetical "Amended at the build increment" — reaching for the dated-marker form one day before #1117 built it.

So a bare byte-identical rule would have refused about one flip in five, and most of those were honest build-time corrections. The rule had to admit the marked form.

## The rule (since #1128)

On a diff where `!isAcceptedAdr(before) && isAcceptedAdr(after)`, the Decision must be:

- **byte-identical** (a Status-only flip — #1123 at `4f411b49` is the real instance and passes with an explicit "allowed" line), or
- **an append-only dated amendment** (`isAppendOnlyAmendment`, the same #1117 escape accepted Decisions use): old words survive, the correction rides in the dated marker.

Refused (2026-09-01; falsify: the matching cases in `scripts/flip-window.test.ts`, each red before the fix): a silent rewrite, a bare undated parenthetical (the 331 shape as it actually happened), and a flip that introduces the `## Decision` section itself — text born frozen was reviewed by nobody. `wasEverOnMain` deliberately does not apply on the flip: a proposed Decision's history is drafts, and "some draft once said this" is not review.

## The diff is the unit, not the commit

Fixing the Decision in one commit and flipping in the next lands as **one refused diff** (2026-09-01; falsify: the two-commit case in `scripts/flip-window.test.ts` goes green without a marker) — the gate reads `base...HEAD` everywhere and cannot see per-commit review. The two sanctioned routes are the dated marker in the flip diff, or the Decision change in its own PR while the ADR is still proposed, with the flip in a later diff. Falsify: the two-commit case in `scripts/flip-window.test.ts` goes green without a marker.

## Related

- [`scripts/flip-window.test.ts`](../../scripts/flip-window.test.ts) — both directions against real fixture repos, red-first.
- ADR 338's baseline (the reviewer charter) classified the finding that produced this page: a reviewer-discovered gap, noted not blocking, routed to a lane with the finder's name on it.
