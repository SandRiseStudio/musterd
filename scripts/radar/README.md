# Research radar scripts

Hand-runnable dry-sweep + optional LLM triage for ADR 056 ingest (M1–M3). Design:
[`docs/design/research-radar-plan.md`](../../docs/design/research-radar-plan.md).

```bash
pnpm radar:sweep
pnpm radar:sweep --json --since 14 --limit 20
pnpm radar:sweep --triage --limit 15   # needs ANTHROPIC_API_KEY
```

Print-only — does not append to `seen.json` or write digests (M4).
Models: tier-1 `claude-haiku-4-5`, tier-2 `claude-sonnet-5` (config constants).
