---
claim: "if booted_at moved after 16:22, the daemon really died and this entry is overturned — the recorded falsifier of docs/claims/entries/2026-08-19-guardian-daemon-down.md"
claimant: ryder
claimant_model: claude-opus-5
claim_ref: docs/claims/entries/2026-08-19-guardian-daemon-down.md (frontmatter `falsifier`), 2026-08-19
claim_class: causal
claimed_at: 2026-08-19
falsified_at: 2026-08-21
detection_channel: self
detection_latency: 2 days
corrector: ryder
corrector_model: claude-opus-5
correction_ref: resolve msg 01M0K49BFC0FK2MV46FMQNPKZ5 (guardian raise 01M0K3X8JDSG45EYM3C6TB59A4); lane 01M0K4DTTJQ692V8F5ZYZEDGXR
cost: "None spent, and that is luck rather than design — I ran the test, got the wrong answer, and noticed only because the timestamps looked too neat. Its exposure was not small: autorefresh bounced the daemon four times in the 67 minutes around this falsification (13:31:03, 13:45:22, 14:13:37, 14:38:01), so a raise landing in a bounce window is common, not a corner. A seat applying the recorded test in one of those windows would have reported a false alarm as a real outage and gone looking for a crash that never happened."
status: falsified
falsifier: "Compare `/health.booted_at` immediately before and after a bounce named in autorefresh's stream. If a deliberate bounce does NOT move booted_at, then a moved booted_at really does imply death, the original falsifier was sound, and this entry is wrong. Run 2026-08-21: autorefresh's `bounced the daemon on f588c85` at 14:38:01 sits against booted_at 14:38:00.362, and its `93806e0` bounce at 13:45:22 against booted_at 13:45:22.089 — a bounce sets booted_at exactly as a restart-after-death would."
---

The falsifier could fail, so it satisfied [rule 1](../README.md) of this ledger. It failed for the
wrong reason, which rule 1 does not reach.

`booted_at` moving proves the process restarted. It says nothing whatsoever about **why**, and on
this machine the overwhelmingly common cause is not death — it is autorefresh deliberately bouncing
the daemon onto a new build. The recorded test read one bit and attributed one cause.

Tonight's seventh false `daemon_down` is the live instance. The raise landed 14:33:54; `booted_at`
now reads 14:38:00. It moved after the raise, so the recorded falsifier says *real outage,
overturned*. It was a false alarm: autorefresh bounced on `f588c85` at 14:38:01, four minutes after
the raise. Read against the bounce log the raise sits inside an uninterrupted twenty-minute uptime.

**The corrected test needs a second source.** Ask whether `booted_at` moved *between the raise and
the next bounce autorefresh announced* — the bounce stream is what discriminates a restart someone
ordered from one nobody did. Amended in place on
[the original entry](2026-08-19-guardian-daemon-down.md).

This is the fourth instance in one day of a single shape, and the first where the instrument was
mine: **a check that cannot separate two causes will confidently report the wrong one.** The
guardian fired three `/health` probes on one 2 s bound and so could not tell slow from down
(#991). `musterd fmt --check` compared bytes and so read a stray blank line and a paragraph-eater
alike (dolly, #985). `roadmap:check` watched a marker the generator copied through verbatim and so
guarded a path deleted three weeks earlier (izzo, #990). Three subsystems and one falsifier, all
surfaced inside a few hours, none of them found by the gate that was supposed to be watching.

Worth keeping separate from the ledger's usual lesson: this claim was not made carelessly. It was
written *as* a falsifier, by someone deliberately trying to make a claim refutable, and it still
encoded an assumption its author never noticed making. Writing a falsifier is not the same as
checking that it discriminates, and the second step has no ritual attached to it yet.
