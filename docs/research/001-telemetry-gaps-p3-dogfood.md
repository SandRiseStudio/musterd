# 001 — Telemetry gaps: the flagship session left almost no machine trace

**Question.** Was musterd's flagship multi-agent session (the P3 cutover, 4 agents, ~28 h, team
"ritual", 2026-06-29/30) observable from musterd's *own* telemetry — the thing musterd is *about*?

**Setup.** Post-hoc reconstruction of the session from every available source (the daemon SQLite DB,
`daemon.log`, the four agents' Claude Code transcripts, git). Cross-referenced against the observability
strategy (`../design/observability.md`, ADRs 051/052/056) and the post-mortem
(`../design/lanes-and-the-multi-agent-tax.md`).

**Baseline.** The intended posture: agent-facing features "ship with traces + an eval the way they ship
with tests" (ADR 052 obs-evals gate); OTel spans per envelope (ADR 015); the trace → eval → experiment
flywheel (ADR 051). Expectation: the session should be replayable from emitted telemetry.

**Result — NO. The only full-fidelity trace was the message DB.** Concrete gaps:

1. **OTel built but inert.** `telemetry.ts` / `otel.ts` emit spans, but the SDK only boots when
   `OTEL_EXPORTER_OTLP_ENDPOINT` is set — it wasn't (zero `telemetry_on` log lines all session). Every
   span was a no-op. **Nothing was exported.**
2. **`daemon.log` is info-only routing metadata, no HTTP layer.** It logs `route`/`ws_hello`/`ws_close`/
   `reap_*` — but **no HTTP request/endpoint/method/status** logging by design, and **zero error/warn
   lines** the entire window (`daemon.err.log` is 0 bytes). Useful for connection/delivery counts; useless
   for latency, failures, or per-request cost.
3. **No PostHog project.** Zero `posthog` wiring in the repo; checked all five projects in the SandRise
   org — none is musterd. The web dashboard emits nothing.
4. **Langfuse empty.** Reachable, zero traces/observations/datasets for the window.
5. **The audit log (ADR 071) captured nothing.** 0 rows — it only records *governed decisions*
   (reclaim/remove/grants/`send.denied`), and normal coordination fires none. So the flagship
   coordination session left **no audit trail**, despite audit shipping in P2.
6. **No per-agent token/cost telemetry.** The cost split (coordination ≈ 1% of tokens; wasted work ≈ 37%
   of code) had to be reconstructed forensically from Claude Code `.jsonl` transcripts — and **riley's is
   unrecoverable** (Cursor/GLM writes no Claude transcript), so even the forensic path has holes.
7. **`batond` is a name-reservation placeholder**, not a collector.
8. **git can't attribute agents** — all 94 commits authored "Nick Sanders." Only musterd's identity layer
   distinguishes the four agents; the coordination trace exists *only* because of the message log.

Everything we learned came from the **message DB** (171 acts) + `daemon.log` (routing counts) + the
transcripts — reconstructed after the fact, never emitted live.

**Honest-N caveat.** One session, one team, models mixed (Opus/Sonnet/GLM). Line-count and chars÷4 token
proxies are order-of-magnitude. This is a qualitative inventory, not a benchmark.

**What it changes.**
- **Instrument-by-default** — at minimum, dogfood daemons should boot OTel (set the exporter) so the next
  session is measurable live instead of forensically. Feeds `telemetry-l2` on the roadmap.
- The specific gaps (1–7) are the concrete backlog for `telemetry-l2` / `batond` / the obs-evals work.
- **The metrics we had to reconstruct — coordination-token ratio, wasted-work ratio, directed-act latency,
  resolve-rate, dup-rate, landed-work-per-\$ — are the first candidate coordination evals** (feeds
  `coordination-dataset`, the MAST-in-the-wild thesis). They should be *emitted*, not archaeology.
- Meta: for a coordination-observability product, "our own flagship session was near-unobservable" is the
  sharpest argument for the batond line — captured so the reprioritization session weighs it.
