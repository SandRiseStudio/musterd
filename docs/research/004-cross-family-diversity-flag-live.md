# 004 — The model-diversity flag, validated live: Grok + GPT in Cursor, flagged vs silent both correct

**Question.** ADR 101's model-diversity flag shipped in inc1 (PR #144) but had **never observed
cross-family data** — every live occupancy to date was `claude-*`, so the flag had only ever rendered
`unverifiable`. Finding 003 exercised attestation from one non-Claude seat (the `qwen3:4b` lab
fixture) but explicitly left the flag's _rendering_ unexercised: "the `lab` team has no `claude`
seat, so no cross-family **review chain** existed for `report.mast.diversity` to flag or clear." So:
does the flag actually work end-to-end on real, live, multi-vendor occupancies — flag a
single-family chain, stay silent on a diverse one?

**Setup (pinned experiment manifest, ADR 051).**

- **Harness:** Cursor (three separate agent sessions), the real thing a human drives — not a scripted
  fixture. This is the resident-MCP path that attests per-act correctly (avoiding finding 003's G1).
- **Seats (team `difftest`), each provisioned with the ADR 101 attestation baked in:**
  - `musterd agent grokbot  --harness cursor --model grok-4.5`
  - `musterd agent gptbot   --harness cursor --model gpt-5.6-sol`
  - `musterd agent grokbot2 --harness cursor --model grok-4.5`

  Each Cursor session's dropdown was set to match its declared model (grokbot/grokbot2 → Grok 4.5,
  gptbot → GPT-5.6 sol). The `--model` flag (PR #198) persisted the model into `binding.json`; the
  Cursor adapter attested it at claim.

- **Two review chains** (`request_help` → `accept` from a different seat — the ADR 101 flag scope):
  1. `grokbot → request_help → gptbot → accept` — **cross-family** (`grok` + `gpt`).
  2. `grokbot → request_help → grokbot2 → accept` — **same-family** (`grok` + `grok`).

**Baseline.** Before this run the flag had **zero** cross-family live observations — 100% of attested
occupancies were `claude-*`, so the flag's only ever output was `unverifiable`. The flagged/diverse
branches of the logic had never fired on real data.

**Result — both branches correct. The flag works.**

Attestation landed for all three seats (audit, `source=claim`):

```
grokbot2 occupancy.model_attested  old:null → new:grok-4.5
grokbot   occupancy.model_attested  old:null → new:grok-4.5
gptbot    occupancy.model_attested  old:null → new:gpt-5.6-sol
```

`musterd report coordination` (team `difftest`), after both chains closed (2 loops, median 48 s):

```
model diversity (review/approval chains, ADR 101):
  ⚑ thread 01KX4KC5QBTW1SACYS4FCNMAZS — request_help chain single-model-family
    end-to-end (all grok-*) · treat agreement as weak evidence
```

- **Same-family chain (grok ↔ grok) → `flagged` ✅.** The monoculture chain surfaced with the correct
  message and the correct family label (`all grok-*`).
- **Cross-family chain (grok ↔ gpt) → silent ✅.** It closed and produced **no** flag — the flag stays
  scarce and quiet on genuine diversity (the intended behavior: it surfaces only `flagged` /
  `unverifiable`, so _absence_ on a chain known to exist is the pass). Critically, it was **not**
  `unverifiable` — both links attested, so the server classified it as cross-family and correctly
  said nothing.
- **Family derivation correct.** `grok-4.5 → grok`, `gpt-5.6-sol → gpt`; same-family collapsed,
  cross-family separated, exactly as `modelFamily` intends.

**What this closes.**

- **The open path from finding 003.** The flag's mixed-chain rendering is now exercised end-to-end —
  and with two _non-Claude_ frontier families, a stronger test than the Claude+X chain 003 called for.
- **The "dark by default" gap ([#172 context] / the diversity flag readiness).** The seats attested
  because the model was _declared_ (PR #198's `--model` → `binding.json` → adapter). Without that the
  chains would have read `unverifiable` (as every prior chain had). This run is the first end-to-end
  confirmation that the declare-a-model path produces honest, flag-usable data through the whole stack
  (attest → per-act stamp → chain classification → report).

**Honest-N caveat.** N = one run, one cross-family pair (`grok`/`gpt`) + one same-family pair
(`grok`/`grok`), one operator, three Cursor sessions, local single-daemon. It validates the flag's
_logic_ on real data, not a distribution. Not yet exercised: a **three-plus-family** chain, a chain
mixing attested + `unknown` links (the `unverifiable` branch on live data), and the **staleness**
failure mode — a Cursor seat whose dropdown was switched mid-session while its declared `--model`
stayed fixed (the flag would then trust a lying label; the known limitation of harness attestation
that a human declares, per the model-experimentation runbook's caveat). Those are the next pins.

**What it changes.**

- **Graduates the model-diversity feature from "shipped, never observed" to "validated live."** The
  first real cross-family coordination data musterd has ever held.
- **Confirms the manual (`--model`) attestation path is sufficient for a real multi-vendor team** —
  the automatic harness-model-detection work (asking the harness via the MCP `clientInfo` seam, or a
  self-ID consistency tripwire) remains the ergonomics/robustness follow-up, not a correctness
  blocker. The staleness caveat above is the strongest argument for building it.
