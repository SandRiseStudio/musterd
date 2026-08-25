# Research radar — ingest store

> Hand-run scan/triage of new multi-agent-coordination research (ADR 056 ingest half). Design:
> [`docs/design/research-radar-plan.md`](../../design/research-radar-plan.md).
> M1–M4 live (sweep + triage + digest emit; Exploring Next feed added as a third source 2026-08-24); M5 schedule deferred — hand-run weekly.

## Layout

| Path | Role |
| --- | --- |
| `seen.json` | Dedup ledger — arXiv / HF / exn ids already triaged (appended by `--emit`) |
| `prompts/radar-v1.md` | Versioned triage prompt (invoked by `--triage`) |
| `<YYYY-WW>.md` | Weekly digests, one per emitted week |

## Run

Hand-runnable ingestion + optional LLM triage. Print-only unless `--emit` is passed; the radar
never edits thesis docs either way:

```bash
pnpm radar:sweep                 # human table, last 7 days
pnpm radar:sweep --since 14      # widen the window
pnpm radar:sweep --limit 10      # cap printed new candidates
pnpm radar:sweep --json          # machine-readable
pnpm radar:sweep --triage --limit 15   # M3: tier-1 + tier-2 (needs ANTHROPIC_API_KEY)
pnpm radar:sweep --triage --emit       # M4: write this week's digest + mark triaged ids seen
```

Graduation into `research-foundation.md` / ADRs stays a human gate — never auto-merged.
