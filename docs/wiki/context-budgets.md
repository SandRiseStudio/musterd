# Standing-context byte budgets

Every byte in the MCP tools/list render is paid by every seat on every turn — `pnpm context:check` gates it, and it is NOT in the usual local gate list, so run it before pushing any tool-surface change.

## How it bites (2026-08-12; falsify: pnpm context:check on a branch adding tool description text)

Budgets live in docs/perf/context-budgets.json as measured + 5% with a dated justification; the headroom gets silently consumed by accretion, so an innocent description edit can be the one that trips the gate (ADR 254's did, +390 B, discovered only in CI). Raising a budget requires replacing its justification; measure main first — the overage may not be yours.
