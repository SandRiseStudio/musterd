# 121 — Guard `x-musterd-model`: humans never attest a harness model

- Status: accepted
- Date: 2026-07-09

## Context

ADR 119 closed the CLI stamp gap by having every authenticated HTTP request optionally carry
`x-musterd-model`, with `authTouch` re-attesting the ambient occupancy. The CLI `HttpClient` forwards
`resolveAttestedModel(process.env)` on **every** request — including when the Bearer secret is a
human credential (`mscr_`).

That is wrong for the model-as-a-variable kernel (ADR 101): attestation is a **harness** fact about
which model occupies an **agent** seat. A human seat is not a harness. If Nick's shell exports
`MUSTERD_MODEL` (or `ANTHROPIC_MODEL`) while he runs `musterd send` / `inbox` as himself, ADR 119
would stamp his ambient presence — and every subsequent act — with that model id. Diversity chains
that include a human link would then look "attested" when they are not, poisoning the
`unverifiable` honesty rule.

## Problem

Keep ADR 119's agent/CLI re-attest path, but ensure a human seat never receives an ambient model
attestation from `x-musterd-model` — client and server both refuse to apply it.

## Decision

1. **Server (`authTouch`).** Parse `x-musterd-model` only when `member.kind === 'agent'`. For
   `kind === 'human'` (and observers, already skipped), ignore the header entirely — ambient touch
   still runs for liveness (ADR 057), but `AttachContext.model` is never set from the header. No
   audit row. Warn-never-block: a stray header is dropped, not a 4xx.
2. **CLI (`HttpClient`).** Forward `x-musterd-model` only when the Bearer key is a team agent key
   (`mskey_`, `TOKEN_PREFIXES.agent_key`). A human credential (`mscr_`) never sends the header, even
   if the env declares a model. Unauthenticated requests (no key) also skip — nothing to attest.
3. **No protocol bump.** Transport-only; ADR 119's agent path unchanged.

## Consequences

- A human with `MUSTERD_MODEL` in the environment no longer pollutes their occupancy or act stamps.
- Agent fire-and-exit CLI seats keep the ADR 119 fix.
- Defense in depth: even a buggy/custom client that sends the header on a human credential is ignored
  server-side.

## Observability & Evaluation

- **Traces:** no `occupancy.model_attested` with `source: ambient` for human seats; agent ambient
  audits unchanged.
- **Eval:** human `mscr_` + `MUSTERD_MODEL` set → ambient presence `model` stays null and acts carry
  no `meta.model`; agent `mskey_` path still stamps (ADR 119 regression).
- **Experiment:** none yet — unit/integration coverage is the gate.
