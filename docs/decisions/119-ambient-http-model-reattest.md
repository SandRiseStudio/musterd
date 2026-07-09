# 119 — Ambient HTTP re-attests the model (close the CLI stamp gap)

- Status: accepted
- Date: 2026-07-09

## Context

ADR 101 stamped every act from the sender's **attested occupancy**: the WS `send` path keys on the
live presence id; the stateless `POST /messages` path falls back to the member's newest presence with
a non-null `model`. Ambient touches (ADR 057) keep that occupancy sticky via `COALESCE(?, model)`, so
a claim-time attestation survives further one-shots **as long as the presence row itself lives**.

A thin fire-and-exit CLI harness (musterd-lab `agent.py`, finding 003 G1 / [issue #172](https://github.com/SandRiseStudio/musterd/issues/172))
breaks that assumption: claim attests correctly, the first act stamps, then later `musterd send`
subprocesses land with `meta.model = null`. What happens:

1. The claim occupancy ages out of `presenceTimeoutMs` (or the reclaim-grace hold expires) and is reaped.
2. The next authenticated one-shot's `authTouch` finds **no** ambient row and `attach`s a fresh
   connectionless presence with `model = null` — the CLI never sent a model on ambient HTTP.
3. `currentAttestedModel`'s newest-attested fallback finds nothing; the act is stamped blank.

Resident harnesses (MCP + heartbeat) never hit this. The diversity substrate's attestation-coverage
hole is specifically for **non-resident CLI agents** — exactly the Track B / tiny-model seats that
need it most.

## Problem

Re-affirm the harness-attested model on every ambient HTTP touch when the client still knows it
(`MUSTERD_MODEL` / `ANTHROPIC_MODEL`), so a poll-loop CLI agent stamps every act — without inventing a
second occupancy clock, without trusting client `meta.model` (ADR 101 integrity: stamp stays
server-controlled), and without forcing one-shots to hold a WS.

## Decision

1. **`x-musterd-model` header on authenticated HTTP.** Optional, max 120 chars (same cap as claim /
   heartbeat). `authTouch` parses it and passes it into `touchAmbientPresence` as `AttachContext.model`.
   Absent → today's sticky `COALESCE` behavior (never clears). Present → the ambient occupancy is
   (re)attested the same way a heartbeat re-attests.
2. **Audit source `ambient`.** A real change (null → value, or value → different value) writes
   `occupancy.model_attested` with `source: 'ambient'` alongside the existing `claim`/`heartbeat`
   sources. Unchanged value → no audit noise (mirrors heartbeat).
3. **CLI `HttpClient` always forwards the resolved env model** on every request (`resolveAttestedModel`),
   the same resolution claim already uses. No client-supplied envelope meta; the server still strips
   any `meta.model` and stamps from occupancy.
4. **No protocol / schema bump.** Headers are transport, not SPEC; `unknown` remains legal when the
   env declares nothing.

## Consequences

- A CLI agent with `MUSTERD_MODEL` set stamps **every** `musterd send` / inbox / lane verb after the
  claim presence expires — issue #172 closes; finding 003 G1 becomes a regression test.
- Agents that never declare a model stay `unknown` (warn-never-block); the header is never guessed.
- The diversity flag's attestation-coverage metric stops degrading for honest CLI seats.
- Docs: ADR 101's "stateless HTTP falls back to newest-attested" remains true; the ambient touch is
  what now *keeps* something attested for CLI one-shots.

## Observability & Evaluation

- **Traces:** existing `occupancy.model_attested` audit rows gain `source: 'ambient'`; per-act
  `meta.model` + `musterd.model` / `musterd.model.family` spans unchanged.
- **Eval:** attestation coverage on a fire-and-exit CLI harness after presence timeout — every act
  after claim carries `meta.model` equal to the env declaration (baseline: finding 003 / issue #172
  ~5% coverage post-first-act).
- **Experiment:** musterd-lab poll-loop agent with `MUSTERD_MODEL` set; `musterd inbox --peek --json`
  shows non-null `meta.model` on accepts after ≥ `presenceTimeoutMs` idle.
