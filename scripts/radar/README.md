# Research radar scripts

Hand-runnable sweep + LLM triage + weekly digest emit for ADR 056 ingest (M1–M4). Design:
[`docs/design/research-radar-plan.md`](../../docs/design/research-radar-plan.md).

```bash
pnpm radar:sweep                              # print-only dry-sweep
pnpm radar:sweep --json --since 14 --limit 20
pnpm radar:sweep --triage --limit 15          # needs ANTHROPIC_API_KEY
pnpm radar:sweep --triage --emit              # + write docs/research/radar/<YYYY-WW>.md, mark seen
```

Sources: arXiv, HF Papers, and the Exploring Next public feed (`exn`, read-only GET — its
hand-curated items feed the radar, never the reverse). Without `--emit` nothing is written;
with it, every *triaged* id is appended to `seen.json` and a same-week re-emit refuses.
Models: tier-1 `claude-haiku-4-5`, tier-2 `claude-sonnet-5` (config constants).
Tests: `pnpm vitest run scripts/radar/`.
