# 008 — UI/UX Figma execution: the skipped Phase-0 deliverable, now done

- Status: accepted
- Date: 2026-06-10

## Context

Phase 0 of the plan had two UI/UX deliverables: (1) *author* the design briefs in `docs/design/`, and (2) *execute* them in Figma (originally scoped to a separate, cheaper Figma-capable agent). Step 1 happened on 2026-06-09; step 2 never did. We then moved straight into building the server/CLI/MCP and the demo, plus a large membership/governance brainstorm ([ADR 007](./007-v0.2-scope-cut.md)). The Figma execution was the one Phase-0 thread that got skipped — there were briefs but zero produced assets.

This ADR records executing all three briefs and reconciling them with what was actually built in the interim.

## Decision

**Executed all three Figma files** from the briefs, and reconciled the briefs/CLI so docs and reality agree.

Figma files (owner: nick.sanders.a@gmail.com, team `Nick Sanders's team`):

| File | Brief | Key / URL |
|------|-------|-----------|
| `musterd / Brand` | [figma-brief-brand.md](../design/figma-brief-brand.md) | `ogOcNXhGq5THf9OBQgbYQB` — https://figma.com/design/ogOcNXhGq5THf9OBQgbYQB |
| `musterd / Terminal UX` | [figma-brief-terminal.md](../design/figma-brief-terminal.md) | `tgJ7dUNgGmlIMYBVVA5qIQ` — https://figma.com/design/tgJ7dUNgGmlIMYBVVA5qIQ |
| `musterd / Dashboard` | [figma-brief-dashboard.md](../design/figma-brief-dashboard.md) | `NeT7zIOz78OvGcWemE3Bji` — https://figma.com/design/NeT7zIOz78OvGcWemE3Bji |

Exported launch assets committed to [`docs/design/assets/`](../design/assets/): `readme-header.png` (1280×320), `social-card.png` (1200×630), `avatar.png`/`avatar.svg` (512), `badge.svg`.

## Reconciliations (brief/CLI drift found while executing)

The terminal brief declares "these frames ARE the CLI output specification." Since the CLI was already built, **reality wins**: the Figma frames mirror the shipped CLI, and the briefs are corrected to match. Specifics:

1. **ASCII banner — source of truth is the CLI, not Figma.** The brand brief assumed the block wordmark would be generated in Figma and copied into `packages/cli`. The CLI already ships one (`renderBanner()` in `packages/cli/src/render/rows.ts` — a 4-line lowercase figlet). The Figma `wordmark/ascii-block` mirrors that exact string. Brief note corrected.
2. **`team add` (agent) hint.** Brief said a generic join token/command. The CLI actually emits an MCP env block (`connect this agent via MCP with env:` + `MUSTERD_TEAM=… MUSTERD_SURFACE=claude-code`). Figma `cmd/team-add` mirrors the CLI; brief corrected.
3. **`join` default surface is `cli`**, not `claude-code` (the brief's example). Figma `cmd/join` shows `via cli`.
4. **Error/empty strings verified against the CLI** and found to already match the intended UX — including the friendly connection-refused message (`can't reach team server at <url> — is the daemon running? (musterd serve)`, exit 7, via `isConnRefused` in `client.ts`). An earlier worry that this was unimplemented dead code was wrong. `not_found` (exit 6) messages are server-provided, so the `state/unknown-member` frame shows a representative string.

No data-model gaps were found: every Dashboard screen field maps to a column in [01-data-model.md](../architecture/01-data-model.md) (the dashboard brief's pressure-test purpose — it passes).

## Consequences

- The three briefs are re-tagged **executed** with their file links (see each brief header).
- `musterd / Dashboard` is **designed, not built** (v0.3 per ADR 007 / `ROADMAP.md`). Flow prototypes are presented as visual journey strips on the `Flows` page; clickable prototype wiring is deferred until the dashboard milestone.
- Brand + Terminal files are the v0.2-relevant ones and are kept in lockstep with the CLI; any future CLI output change must update `musterd / Terminal UX` in the same spirit (docs/code agree at commit boundaries).
