# Which seat the CLI acts as

The `musterd` CLI resolves a seat from the **working directory**, not from the channel you came in on — so the hazard the primer spent a year warning about was never "tools and CLI at once", it was "CLI from the wrong folder".

## The measurement

Run on 2026-09-17 against daemon build `76b4b16`, one machine, three directories:

| cwd | `musterd whoami` |
| --- | --- |
| `/Users/nick/agents-stanley` | `stanley on revive (cli · binding)` |
| `/Users/nick/agents-miley` | `miley on revive (cli · binding)` |
| `~` (unbound) | `nick on revive (cli · config)  (read-only — global config; claim or use --as to act)` |

`cli · binding` is the CLI naming its own source: `.musterd/binding.json` in that folder. The MCP adapter reads the same file, so in a seat's own Workspace **both channels resolve the same seat by construction**. From a teammate's Workspace the CLI acts as *them* — a real way to send under someone else's name, and the one the old wording could not catch.

The cwd decides the seat (2026-09-17; falsify: run `musterd whoami` from a seat Workspace and from a sibling seat's Workspace — if both name the same member, the cwd does not decide identity and this page is wrong). <!-- claim: other -->

## What the old rule said, and why it was retired

The primer shipped: *"Use one channel only: with the `team_*` tools, do not also drive the CLI (it resolves to a different identity and your sends fail)."* Retired 2026-09-17 by lane 01M2RP18EV for two independent reasons.

1. **The stated cause was gone.** A registration used to be able to bake `MUSTERD_MEMBER` and disagree with `binding.json`. `MUSTERD_MEMBER` was retired by [ADR 075](../decisions/075-p3.3-cli-claim-surface-migration.md) in favour of `MUSTERD_CLAIM`, and **nothing under `packages/` reads it** (2026-09-17; falsify: `grep -rn MUSTERD_MEMBER packages` — a hit outside `dist/` disproves this). The last live instance on this machine was `/Users/nick/SandRise`, whose entry said `Clyde` while its `binding.json` said `Cosmo`, with two different `mskd_` tokens; that workspace was pre-ADR-281, its MCP server had been failing `CONNECTION_CLOSED`, and it was pruned the same day. <!-- claim: other -->
2. **It forbade something the team's own skill prescribes.** `renderOrientSkill` in `packages/protocol/src/guidance.ts` ends orientation on `musterd session orient-stamp` — a CLI write. There is no MCP verb for it: the musterd MCP surface is `lane_*` and `team_*` only, with no `session_*` and no `stream_*`. So every seat that followed the orient skill broke the primer's rule, in the same file that contained both.

## Why this is worth a page

A rule every compliant seat must break does not fail loudly — it fails as self-doubt. Measured on 2026-09-17: a seat asked why it wasn't using the MCP tools listed three CLI calls, correctly excused two as having no MCP equivalent, and convicted itself of the third — *"That's exactly the mixed-channel thing CLAUDE.md warns about: the CLI resolves to a different identity than the seat I joined through MCP."* It had done nothing wrong. Guidance that manufactures false guilt also teaches seats to avoid a working channel, which is how the same session's `lane_board {mine}` overflow (lane 01M2R988GK) turned into a channel switch instead of a bug report.

Related: [running the gates](running-the-gates.md).
