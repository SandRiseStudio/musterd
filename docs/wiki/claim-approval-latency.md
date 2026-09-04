# Claim approval latency — the 120s block usually learns nothing

When a seat claims with no grant, the daemon opens an approval request and the caller blocks: 120s on an MCP surface (`JOIN_WAIT_MS`, `packages/mcp/src/tools/join.ts`), 300s on the CLI (`--timeout`, `0` = unbounded). The question nobody had asked until 2026-09-03 is whether an approval usually arrives inside that window. It does not.

## The measurement (2026-09-03, this laptop's daemon)

Every claim request ever opened on `~/.musterd/musterd.db`, 2026-07-03 to 2026-08-21, joined to its `request.decide` audit row:

| | all | from an MCP surface |
| --- | --- | --- |
| requests opened | 38 | 33 |
| decided within 120s | 8 | 5 |
| decided later than 120s | 20 | 18 |
| never decided (expired) | 10 | 10 |

Median approval latency is about 150s. The longest was 3149s, 52 minutes. **28 of 33 MCP claims could not be satisfied inside the block.** The five that were are the interactive case: a human at the keyboard who approves within a minute or two.

Reproduce it:

```sql
select r.surface, r.status, round((a.ts - r.created_at)/1000.0, 1) as wait_s
from requests r
join audit a on json_extract(a.detail,'$.request_id') = r.id and a.action = 'request.decide'
where r.kind = 'claim'
order by wait_s desc;
```

Falsify: run that against a fresh window. The claim here fails if most MCP claims come back decided inside 120s.

## What follows from it

- The block is the **interactive** default, not a wait that usually works. An autonomous seat should pass `wait: 0` (ADR 095, landed 2026-09-03) and keep working; the socket stays parked and the seat occupies in the background when the approval lands.
- It does **not** license dropping the default to zero. The in-budget approvals are the human-present path, and a seat that quietly returns pending is worse for that person, not better.
- The half that is still missing is being told. On approve the daemon writes no directed act, so a released caller learns it is seated at its next `team_join`, not at its next tool boundary — and 18 of the 33 approvals landed after the caller had been released. That is ADR 095 decision 3, deferred with a named trigger.

## Why this sat unmeasured for two months

ADR 095 was written 2026-07-06 with a committed implementation plan, and neither was referenced again — zero hits in source, wiki, or 843 lanes when ryder's sweep found it on 2026-09-03. The premise was arguable from the code alone the whole time; what nobody had done was read the `requests` table, which had the answer in it from the first week. A spec and a plan are not evidence that a problem is real, and neither is their silence evidence that it is not. Related: [constraint-outlives-its-premise](constraint-outlives-its-premise.md).
