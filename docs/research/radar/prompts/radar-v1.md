# Research radar triage — prompt_version: radar-v1

> Invoked by `pnpm radar:sweep --triage` (M3+). Pin this version id on every triage
> report / digest frontmatter so the radar is a small ADR 051/052 flywheel data source.

## Relevance dimensions (musterd thesis surface)

Score each candidate against:

1. **coordination-layer** — between-agent messaging, protocols, topology
2. **human-agent-loop** — collaboration, notification, dual control, HITL
3. **notification-reachability** — async notify beats watch; interrupt / wake
4. **agent-eval-observability** — traces, failure detectors, coordination metrics
5. **failure-taxonomies** — MAST and kin; multi-agent failure modes in the wild
6. **multi-agent-topology** — team shape, roles, orchestration vs peer seats

## Weighted score + floor

Produce a weighted overall relevance score (0–1). Below the relevance floor →
verdict `ignore` (never surface). Diagnostic only — never a ranking of Members
(`human-agent-dynamics.md` §4 Goodhart caution).

## Verdict ladder → graduation gate

| Verdict | Meaning | Human next step |
| --- | --- | --- |
| `ignore` | Below floor / off-thesis | Nothing |
| `record-as-evidence` | Supports or nuances an existing claim | Append to `research-foundation.md` |
| `consider-ADR` | Would change a decision | Draft ADR + roadmap item on request |

No auto-merge into the thesis.

## Brutal honesty (required gut-check)

Be ruthlessly honest. If this repackages known ideas, say so. If an existing approach already
covers it, name it (Co-Gym, MAST, AgentOps, LumiMAS, musterd ADRs). Give a 2–3 sentence
unvarnished gut-check. Anti-hype; pairs with ADR 056's Goodhart cautions.

## Output per shortlisted paper (tier-2)

- title · link
- 1-line what
- why-it-matters-to-musterd (which dimension / which ADR it touches)
- honest gut-check
- confidence
- verdict
