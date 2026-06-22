# Figma Brief 3 — "musterd / Dashboard"

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

**Audience:** a Figma-capable agent. **Designed now, built post-v1** (see `ROADMAP.md` — the web dashboard is a roadmap surface, not a v1 deliverable). The point of designing it now is to pressure-test the data model: every screen here must be expressible with the schema in [`../architecture/01-data-model.md`](../architecture/01-data-model.md). If a screen needs a field the schema lacks, that's a finding → ADR, not an invented column. Derive all values from [`brand.md`](./brand.md).

---

> **Status: EXECUTED — designed, not built** (2026-06-10, see [ADR 008](../decisions/008-ui-ux-figma-execution.md)). File: [musterd / Dashboard](https://figma.com/design/NeT7zIOz78OvGcWemE3Bji). 7 components, all 4 screens in light + dark, and the 3 journeys on the `Flows` page (visual strips; clickable prototype wiring deferred to the dashboard milestone). Data-model pressure-test passed — every field maps to a column, no schema gaps.

## File

- **Figma file name:** `musterd / Dashboard`
- **Pages:** `Components`, `Screens`, `Flows`
- **Modes:** every screen in **light and dark** (use the `musterd/core` variable modes from the Brand file).

## Page: Components (component-first — build BEFORE Screens)

Define these as components with variants; screens may only compose these:

1. `ui/member-chip` — avatar/initial + name + kind icon (agent/human). Variants: `kind=agent|human`, `size=sm|md`.
2. `ui/presence-dot` — variants `online|away|offline`; tooltip shows the Surface (`claude-code`, `codex`, `cli`).
3. `ui/act-badge` — one variant per Act (`message, status_update, request_help, handoff, accept, decline, wait, resolve`). Color roles per `brand.md` (request_help=accent, decline=danger, resolve=success/done, others neutral with subtle tints).
4. `ui/message-row` — timestamp, member-chip (from), act-badge, body, optional `to` (member/team/broadcast), optional thread indicator.
5. `ui/lifecycle-tag` — `forever | session | until <date>`.
6. `ui/roster-item` — member-chip + role + presence-dot + lifecycle-tag, used in lists.
7. `ui/nav` — left nav: teams list + active team.

## Page: Screens

Each named `screen/<name>`, in light and dark:

1. `screen/team-roster` — left nav (teams) + main roster of `ui/roster-item`s for the active team, header with team name + member count + "add member" action. This is the home screen.
2. `screen/member-detail` — a Member's identity: name, kind, role, **all current Presences** (one `presence-dot` + Surface per active attachment — demonstrates one-Member-many-Presences), lifecycle, availability schedule (read-only display; v1 stores but does not enforce — label it "not enforced yet"). Recent activity feed of that member's messages.
3. `screen/message-timeline` — the team's message stream: `ui/message-row`s grouped by day, filterable by Act type and by Member. Threaded replies indent under their parent. A live-region indicator mirrors `inbox --watch`.
4. `screen/team-settings` — team name, default lifecycle, member management (add/remove/role edit), danger zone (archive team). Read-only fields that map 1:1 to schema columns.

Annotate every field on every screen with its backing column from `01-data-model.md` (e.g. `member.role`, `presence.surface`, `message.act`). Any unmappable field is a finding.

## Page: Flows (the 3 core journeys)

Build as connected frames (prototype links) telling each story:

1. **Watch a team work** — land on `team-roster` → open `message-timeline` → see live `status_update`s stream in. (Mirrors `musterd inbox --watch`.)
2. **Answer a request_help** — notification of an incoming `request_help` (accent) → open the message → reply with a `message` / `accept`. (The flagship human-as-peer moment.)
3. **Add a member** — from `team-roster` "add member" → form (name, kind, role, lifecycle) → new `roster-item` appears offline until it attaches a Presence.

## Acceptance checklist

- [ ] All 7 components exist with the listed variants, bound to `musterd/core` variables.
- [ ] All 4 screens exist in both light and dark.
- [ ] Every screen field is annotated with its backing schema column; zero unmapped fields (or each unmapped field has a logged finding/ADR).
- [ ] All 3 flows are wired as clickable prototypes.
- [ ] One Member is shown with two simultaneous Presences on `member-detail` (proves the identity/presence split visually).
- [ ] Availability schedule is visibly labeled "not enforced yet" (matches roadmap honesty rule).

## Iteration protocol

1. Components first → screenshot → sign-off.
2. Screens (light first, then dark) → per-screen screenshots.
3. Flows last → record a short prototype walkthrough.
4. Revisions named per screen/component only. When green, mark done; note that no build happens until the dashboard milestone on `ROADMAP.md`.
