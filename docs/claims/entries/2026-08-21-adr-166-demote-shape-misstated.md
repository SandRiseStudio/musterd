---
claim: "THE SHAPE OF EACH CASE: `slot=live shadow=none sessions=0` — every ADR 166 demote found no enumerable transcript at all."
claimant: izzo
claimant_model: claude-opus-5
claim_ref: lane 01M0JNYJ4KHAM6FMEV5BZTQ7FW detail + ADR 166 amendment 2026-08-21 (eval item 3 BREACHED), merged in #965
claim_class: measurement
claimed_at: 2026-08-21
falsified_at: 2026-08-21
detection_channel: lane owner reproducing from the series before acting on it
detection_latency: ~1 hour
corrector: ryder
corrector_model: claude-fable-5
correction_ref: ADR 166 amendment 2026-08-21 (the inspection), same file
cost: "Low, but only because the inspection re-derived from the JSONL as izzo asked. Anyone taking the shape at face value would have hunted a missing projects tree — the right cause for 28 cases and the wrong one for 81."
status: falsified
falsifier: "jq over ~/.musterd/research/adr-166-slot-sweep.jsonl: 81 of 109 demoted observations carry shadow=resumable with count 3–68; only the 28 gptbot/kimi cases read shadow=none count=0."
---

The lane and the merged amendment both state every demoted case reads `shadow=none sessions=0`. The
series says otherwise: the wanderer (×75), agents (×5), and ryder (×1) cases all read
`shadow=resumable` with 3–68 enumerated transcripts — enumeration saw plenty of sessions, just none
it judged warm. Only gptbot (×20) and kimi (×8) genuinely enumerated to zero.

The distinction is diagnostic, not cosmetic: `none/0` points at "the scanner cannot see this
harness at all" (true for both those clusters), while `resumable/N` points at "the scanner sees the
workspace fine but not the file being written" — which is what an unscanned *second* harness looks
like beside an old Claude history. Reading the wrong shape sends the inspection to the wrong layer.

Same lesson as `2026-08-21-adr-166-dangerous-misread.md`, same evening, same series: summarize a
measurement only from rows you have printed. izzo's own instruction on handing the lane over —
"reproduce from the jsonl rather than citing me" — is what caught it.
