# The three claim paths

`musterd claim`, `claim --detach`, and every ordinary CLI command each occupy a seat by a different route — so a fix to one is not a fix to the others, and twice in one day it was mistaken for one.

## The map (2026-09-05, at `e8e9301a`; falsify: `grep -n "watchClaim\|http.claim\|claimSessionLease" packages/cli/src/commands/claim.ts packages/cli/src/commands/helpers.ts packages/cli/src/client.ts` — three distinct entry points, or this page is out of date)

| path | entry | transport | who takes it |
|---|---|---|---|
| **live claim** | `watchClaim` (`client.ts`) | WS `claim` frame, socket held | `musterd claim <seat>`, the MCP adapter, `inbox --wait` |
| **stateless mirror** | `HttpClient.claim` (`client.ts`) | `POST /teams/:slug/claim`, one shot | `claim --detach`, `musterd human` provisioning |
| **per-request claim** | `claimSessionLease` → `watchClaim` (`client.ts`) | WS, opened and closed around one HTTP call | **every ordinary CLI command** |

The third is the surprising one. `resolve()` sets `claimSeatPerRequest: true` **unconditionally** (`helpers.ts`), so `musterd status`, `musterd lanes`, `musterd send` — every act and most reads — re-claim the seat before doing their work. A command you think of as read-only mints a claim, and that claim can displace a session.

`resolveRead()` takes a flag instead, and the one caller that passes `false` is the interrupt-check probe (ADR 088) — deliberately, so a hook firing on every tool call cannot storm the seat. That asymmetry is the subject of its own finding: the probe therefore fails closed on a stale lease while every other command silently self-heals.

## Why the split keeps costing

Each fix below was written believing it covered "the claim". None did:

- **[#1289](https://github.com/SandRiseStudio/musterd/pull/1289)** carried `workspace` on the stateless mirror. The live claim already had it; the per-request claim did not need it. One path.
- **[#1309](https://github.com/SandRiseStudio/musterd/pull/1309)** added `provenance` to the stateless mirror's three occupy branches. I then ran `MUSTERD_PROVENANCE=session musterd claim` to verify it on the live rail and got `provenance: (null)` — because `musterd claim` does not use that route at all. **A verification that exercises the wrong path reads exactly like a broken fix** (2026-09-05; falsify: the audit row for that claim carries `surface: cli` and `via: ws`).
- **[#1322](https://github.com/SandRiseStudio/musterd/pull/1322)** then carried it on the live claim, which is the path `musterd claim` actually takes.
- **[#1339](https://github.com/SandRiseStudio/musterd/pull/1339)** restored `workspace_key` on the stateless mirror; **[#1341](https://github.com/SandRiseStudio/musterd/pull/1341)** had to restore it again, separately, on the per-request claim.

Four fixes, two fields, three paths. The class is [resolved then dropped](resolved-then-dropped.md); the reason it recurred is this page.

## Before you claim a claim-path fix is done

Name which of the three you changed, then check the other two by grep rather than by memory. The wire frames are built in different places (`buildClaimFrame` for both WS routes, a hand-assembled body for the HTTP one), so a field added to one builder reaches at most two paths and possibly one.

To verify on the live rail, use the command that takes the path you changed:

- live claim → `musterd claim <seat>`
- stateless mirror → `musterd claim --detach`
- per-request → any ordinary command, e.g. `musterd status`

Then read the row it wrote: `sqlite3 ~/.musterd/musterd.db "select surface, provenance, workspace, datetime(created_at/1000,'unixepoch','localtime') from presence order by created_at desc limit 5"`. Note the daemon must be running a build that contains your change — check `musterd service status` first, since the auto-refresher lands merges on a 120s tick and a null result against an old dist proves nothing.

## One caution about testing this by hand

A CLI `musterd claim` re-mints the **CLI's** session lease, not the MCP adapter's. After a daemon bounce or a reap, the CLI keeps working while MCP writes still fail with `invalid, expired, or revoked agent session lease`; the repair is a `/mcp reload` by the human. So "claim it and see" from inside a seat session can leave your own tool surface broken — reviewers on 2026-09-05 declined to run it for exactly this reason, and verified against tests plus rows instead.
