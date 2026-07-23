# Research radar scripts

Hand-runnable dry-sweep for ADR 056 ingest (M1–M2). Design:
[`docs/design/research-radar-plan.md`](../../docs/design/research-radar-plan.md).

```bash
pnpm radar:sweep
pnpm radar:sweep --json --since 14 --limit 20
```

Print-only — does not append to `seen.json` or write digests (M4).
