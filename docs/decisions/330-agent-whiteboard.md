# 330 — Agent whiteboard: standalone provider-agnostic service and brainstorm skill

- Status: proposed
- Date: 2026-08-26
- Builds on: [ADR 144](144-mcp-tool-surface-measure-then-craft.md) (why `whiteboard_*` lives outside the musterd tool registry rather than becoming a third namespace in it), [ADR 259](259-memory-git-truth-derived-indexes.md) (where a brainstorm's durable output lands, and what stays out of the repo), [ADR 085](085-layered-guidance-surface.md) (why the whiteboard skill is not guidance-rendered)

## Context

Brainstorming with a member is a different mode of work from lanes and acts: divergent, spatial,
and shared. A predecessor existed outside musterd — a GitHub Copilot facilitator agent backed by
tldraw MCP tools — and it earned its keep: ideas as sticky notes, arrows as relations, clusters as
themes, a human and an agent drawing on the same canvas. musterd has no equivalent surface, and
the craft that made the predecessor work (diverge before converging, technique kept invisible)
lives today in files musterd sessions never read.

Three constraints shape the recreation:

1. **Provider-agnostic.** tldraw is the first canvas provider, not a commitment. Nothing above
   the adapter may know a tldraw record shape exists.
2. **Standalone and extractable.** The service must be liftable into its own repository at any
   time. Living inside the monorepo buys the gate chain and review ritual, not coupling.
3. **musterd invariants hold.** Every write into a repository carries a seat identity; the lane
   ownership gate and model attestation must see all of it. A service process has none of those,
   so it must never author repo content.

ADR 144 fixed the musterd MCP registry at exactly two namespaces — `team_*` (coordination) and
`lane_*` (work-board lifecycle) — and requires an ADR to argue a third. A whiteboard is neither
coordination nor work-board lifecycle, and forcing it into the registry would also chain the
extractable package to `@musterd/mcp`.

## Decision

1. **A new package, `packages/whiteboard`, owns the whole feature.** It imports nothing from
   `@musterd/*` — enforced by a test, because that is the extraction guarantee, not a preference.
   It ships its own MCP server, its own SKILL.md, and stores boards under its own data directory
   (`~/.whiteboard/`, env-overridable), deliberately not under `~/.musterd/`.

2. **`whiteboard_*` is an external namespace, not a third registry namespace.** The package's MCP
   server registers six tools: `whiteboard_open`, `whiteboard_add`, `whiteboard_read`,
   `whiteboard_edit`, `whiteboard_close`, `whiteboard_list`. musterd's `TOOL_NAMES`,
   `SKILL_MCP_TOOLS`, and guidance renderers are untouched. This is the ADR 144 escape hatch used
   as designed: the namespace argument is made here, and the answer is "outside".

3. **A provider port is the only interface the tools and skill see.** Its vocabulary is the
   brainstorm's, not the canvas library's: *note*, *label*, *link* (A→B), *cluster* (a named
   grouping). The tldraw adapter is the single module that translates to canvas records, ported
   from the predecessor's canvas operations. Swapping providers later means writing one adapter.

4. **Reads are text-first and versioned.** Notes, labels, links, and clusters are lossless as a
   structured outline (a link is a binding between two named things, not coordinates), so the
   common read costs no image tokens. Every read returns a monotonic version; `since` returns
   only what changed, with authorship. Rendering the canvas as an image — needed only once
   freehand strokes or pasted images appear — is increment 2, produced by the connected browser
   page over the existing sync socket; a headless browser dependency is rejected.

5. **Every shape carries its creator.** Agent-placed shapes are stamped with the seat name;
   human shapes are attributed via sync presence. "What changed since" therefore answers the
   question that matters in a shared session: *what did the other party draw*. Convergence is
   legible in both directions — the agent proposes a grouping with `whiteboard_edit`, the human
   dissents by dragging shapes back out, and the next read shows exactly that. The edit policy
   and the stamp are properties of the well-behaved caller, not of the system: `actor` is
   caller-supplied on the localhost HTTP surface (the MCP server pins it per session), so this
   is a guardrail against accident, never authentication — the same posture ADR 328 takes for
   an unauthenticated origin.

6. **The service never writes into a repository.** `whiteboard_close` returns the final outline;
   the seat authors the summary as a design exploration in `docs/design/` under its own identity,
   inside its own lane. Boards themselves stay out of git: mutable working state, with the
   reviewed artifact being the seat-authored document. Promotion of any settled fact to the wiki
   remains a separate, deliberate act (ADR 259).

7. **The skill is hand-authored in the package, not guidance-rendered.** ADR 085's layering puts
   musterd's own playbooks in `guidance.ts`; this skill is the extractable package's property and
   names only `whiteboard_*` tools, so it lives at `packages/whiteboard/SKILL.md` (canonical)
   with an installed copy under `.claude/skills/`. Unstamped files are preserved by the guidance
   writer, so the two systems do not collide. The craft it carries — diverge first, converge
   late, technique invisible — is ported from the predecessor's best surviving text.

8. **Lifecycle is spawn-on-demand.** The first `whiteboard_open` that finds the service port dead
   spawns it detached and waits for health. No LaunchAgent, no always-on process.

## Observability & Evaluation

- **Traces:** the service emits structured JSON logs (open/persist/teardown per board,
  ws connections, API errors) to its own stdout; it is deliberately outside musterd's
  telemetry — a local pairing surface with no team authority. The MCP tool results themselves
  are the observable surface a session leaves behind.
- **Eval:** the package's own suite is the gate: adapter round-trip (write half readable by
  the read half — links resolve endpoints, clusters carry members, attribution survives),
  versioned-diff correctness against live room clocks, edit-policy refusals, a real ws sync
  handshake, and the registry pin that keeps SKILL.md tool names honest. Baseline: the
  predecessor, whose own read path returned empty text for every note it wrote — the
  round-trip suite exists so that class of defect cannot land silently.
- **Experiment:** whether shared-canvas brainstorming earns its keep is judged by use: if no
  board accumulates sessions across days within a month of landing, the "persist, reopenable"
  half was speculative and should be revisited before increment 2.

## Consequences

- One more long-lived local process may exist after a brainstorm; it is idle and holds no
  authority — it cannot act on the team, and nothing in musterd depends on it.
- The `guidance:check` gate does not cover the whiteboard skill's tool names; the package's own
  registry test pins tool names to registrations instead, keeping rename-rot caught at the same
  cost in its own home.
- If the package is extracted, the monorepo loses only a directory and an `.mcp.json` entry; the
  skill, service, and data directory move intact.
- Increment 2 is recorded, not promised: browser-rendered image export, and a long-poll variant
  of `whiteboard_read` so a facilitating seat waits instead of polling.
