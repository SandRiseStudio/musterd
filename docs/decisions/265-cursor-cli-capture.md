# 265 — Cursor CLI capture: enumerate the transcript, do not inherit a dead session's model

- Status: proposed
- Date: 2026-08-13
- Lane: `01KZYW7SCZCBYTRZR1H076M2C0`
- Builds on: [ADR 198](198-cursor-hooks-observe-model.md), [ADR 158](158-model-attestation-truth.md), [ADR 131](131-harness-residency-wake-ledger-host.md), [ADR 166](166-session-liveness-by-enumeration.md)

## Context

Stub. Full text in the next commit on this branch. Reserves 265 per ADR 223.

## Problem

A Cursor seat driven from `cursor-agent` never fires the ADR 198 hooks, so the roster attests a previous desktop session's model and `session show` reads the live workspace as idle.

## Decision

(reserved)

## Consequences

(reserved)

## Observability & Evaluation

**Traces.** (reserved)

**Eval.** (reserved)

**Experiment.** (reserved)
