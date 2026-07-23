# Research radar — ingest store

> Hand-run scan/triage of new multi-agent-coordination research (ADR 056 ingest half). Design:
> [`docs/design/research-radar-plan.md`](../../design/research-radar-plan.md).
> M1–M3 live; weekly digest + schedule = M4–M5 (not built).

## Layout

| Path | Role |
| --- | --- |
| `seen.json` | Dedup ledger — arXiv / HF ids already surfaced (append on digest emit, M4) |
| `prompts/radar-v1.md` | Versioned triage prompt (invoked by `--triage`) |
| `<YYYY-WW>.md` | Weekly digests (M4+) — none yet |

## Run (M1–M3)

Hand-runnable ingestion + optional LLM triage — fetch + dedup report; does **not** write digests,
mark seen, or edit thesis docs:

```bash
pnpm radar:sweep                 # human table, last 7 days
pnpm radar:sweep --since 14      # widen the window
pnpm radar:sweep --limit 10      # cap printed new candidates
pnpm radar:sweep --json          # machine-readable
pnpm radar:sweep --triage --limit 15   # M3: tier-1 + tier-2 (needs ANTHROPIC_API_KEY)
```

Graduation into `research-foundation.md` / ADRs stays a human gate — never auto-merged.
