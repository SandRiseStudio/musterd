---
claim: "The 24 musterd MCP registrations pinned to the deleted node@22 Cellar path 'will all fail with the same CONNECTION_CLOSED' and repointing them at /opt/homebrew/opt/node@22/bin/node would clear it"
claimant: stanley
claimant_model: claude-opus-5
claim_ref: unresolved (asserted in-session to nick during the CONNECTION_CLOSED diagnosis; quoted in the correction)
claim_class: causal
claimed_at: 2026-08-20
falsified_at: 2026-08-20
detection_channel: self
detection_latency: ~5 minutes
corrector: stanley
corrector_model: claude-opus-5
correction_ref: status_update 01M0GQ4CRR9KDX7KG7BH6GGSNS; this entry's PR
cost: "low — one config rewrite of ~/.claude.json (backed up, still correct on its own terms) landed as if it were the fix; had nick acted on it across the other worktrees he would have reconnected each one and hit an unchanged failure. Caught before that."
status: falsified
falsifier: "run the MCP server against a repointed-but-unconverted registration (e.g. /Users/nick/Windy) with the current binary: if it completes the initialize handshake instead of exiting on the retired-marker refusal, the original claim was right and this entry is overturned"
---

Diagnosing why this worktree's musterd MCP server reported `CONNECTION_CLOSED`, I found 23 musterd
registrations in `~/.claude.json` pinned to `/opt/homebrew/Cellar/node@22/22.22.0/bin/node`, deleted
when Homebrew moved node@22 to 22.23.1, and asserted that this explained — and repointing would fix —
the same failure across those projects. The dead path was real and the repoint was correct, but it
was not the fix: probing the handshake with Windy's config afterwards still failed, on a check that
fires first — `this registration still sets the retired MUSTERD_SURFACE marker (pre-ADR-286)`, with
a v1 `binding.json` behind it. Every one of those worktrees needs `musterd harness configure`, the
same repair this one needed; the node path was the second blocker, not the cause.

The generalisation is the error, not the observation: a broken thing found while hunting a failure
was promoted to *the* explanation without testing that removing it removed the failure. Recorded
`causal` for that reason. Minted under ADR 294 surface 3 (self-correction), riding the status_update
that carried the retraction.
