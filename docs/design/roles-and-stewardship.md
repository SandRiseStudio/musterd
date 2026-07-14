# Roles & stewardship — capture for a future design session

> **Status: capture, not design.** This document records the owner's intent (2026-07-13) so the
> eventual brainstorm/design session starts from the full picture instead of re-discovering it. It
> deliberately makes no decisions. The roadmap item `roles-and-stewardship` points here.

## The prompting problem: who may touch running infrastructure?

Today any agent on the team can restart/reload/rebuild shared infrastructure — the daemon, the /live
viewer, the shared checkouts — and can modify musterd platform code, while other agents are online and
depending on that infrastructure. The dogfood record shows both the cost and the near-misses: a
`service install` from the wrong shell crashlooped the daemon for everyone (2026-07-12); an agent
almost bounced the daemon to "fix" a UI change that needed no daemon action at all; refreshes drop
teammates' live sessions.

**Desired end state (owner's words, condensed):** only _designated_ platform agent(s) may touch
running infrastructure — restart/reload/build any infra — or modify musterd platform code. Everyone
else, when they need infra changed or troubleshooting help, **asks the platform agent(s)** (the
`request_help` act, routed by role) instead of doing it themselves.

**Explicit leniency for now:** the team is still _building_ musterd itself, so agents must be able to
do platform work. Any enforcement shipped early must be permissive/warn-first (the lanes doctrine:
watcher, never gatekeeper) until the platform stabilizes enough to harden.

## What already exists to build on (do not re-invent)

- **The capability substrate (ADR 069/070, P0–P3 landed).** Seats carry `account_status` +
  `capabilities`; `roles/<name>.toml` carries role defaults + a charter; per-seat narrowing (never
  widening); in-band enforcement + the audit trail. "Only designated agents touch infra" is, at the
  mechanism level, a capability — most of the machinery is already live.
- **Provisioning role templates (ADR 026–030).** `onboard/role.ts` + the built-in template library
  render a role per harness at provisioning time. Needs re-freezing against ADR 101
  (model-as-a-variable: a template should be able to declare a model family) — noted on the
  `own-harness` item before this split.
- **The steward (ADR 112).** The first _worked example_ of exactly the role pattern the owner wants:
  a named responsibility (keep the declared record honest) with its own charter
  (`scripts/steward/CHARTER.md`), autonomy knobs per task (`propose` vs `auto-merge`), and guardrails
  (draft PRs, `roadmap-truth:check` as the seatbelt). Today it is launched by a GitHub Action on a
  schedule rather than living as a resident seat — the residency work (ADR 131; its increment plan
  already names a "steward swap") is what turns role-agents like it into standing teammates.
- **The planner/orchestrator stance** (`no-orchestrator` roadmap item): musterd has no privileged
  orchestrator _in the protocol_; a planner is just a member whose charter says "plan". Roles must
  keep that property — a role is a charter + capabilities on an ordinary seat, never a new protocol
  power.
- **Guardrails that already ship:** the live-session guard (ADR 047) makes daemon bounces a conscious
  choice; `service install` refuses an ABI-mismatched node; build provenance (ADR 135) makes stale
  runtimes name themselves. These are _how_ checks; the roles work adds the _who_.

## The role library the owner wants (initial wishlist)

| Role                          | Sketch of the charter                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Platform / infra guardian** | The designated toucher of running infrastructure: daemon lifecycle, service refresh/install, shared checkouts, migrations. Other agents route infra requests + troubleshooting here. |
| **Steward**                   | Exists (ADR 112) — keep the declared record honest. Wants to become a resident seat rather than a scheduled Action.                                                                  |
| **Product manager**           | Owns the roadmap conversation, priorities, and what "done" means for a Goal.                                                                                                         |
| **UX/UI designer**            | Owns the design surfaces (/live, CLI output contract, Figma frames).                                                                                                                 |
| **Experimenter**              | Owns eval/experiment design and runs (the ADR 051/052 flywheel, cookoff-style cells).                                                                                                |
| **Researcher**                | Landscape/prior-art sweeps, the research radar.                                                                                                                                      |
| **Customer support**          | Triage inbound issues/questions; the human-facing voice.                                                                                                                             |
| **Database guru**             | Schema/migration review, data integrity, query performance.                                                                                                                          |
| **Facilitator / brainstorm**  | Human-paired diverge→converge seat. Runs design/planning sessions; never owns implementation lanes. Success = a decided direction landed as a Goal/lane/ADR — not a PR.             |

The library should be open-ended — these are seeds, not a closed set.

### Seed sketch — Facilitator / brainstorm (captured 2026-07-13)

Dogfood evidence for this seed (not a product decision):

- An earlier attempt provisioned a brainstorm seat with **tldraw MCP** so a human and the agent could
  whiteboard live in one canvas — strong for **diverge** (messy systems, flows, exploration).
- A later session on Cursor + GPT-5.6 used the **Superpowers brainstorming** skill with its visual UI
  companion (option cards with stance tags + visuals beside the chat) — strong for **converge**
  (pick-one among named directions).

These are complementary modes of one role, not competing products: **diverge** on a shared mutable
board, **converge** on a structured decision surface, then **hand off** the chosen direction into a
Goal/lane/ADR for coding seats. Keep the portable template as charter + intent (“visual facilitation
surface”); render tldraw / harness companion / FigJam per harness so the role stays
harness-independent (see Q5). Distinct from `no-orchestrator`: this seat helps a human decide one
direction — it does not become the team’s mandatory dispatcher.

## Questions for the design session (deliberately unanswered here)

1. **Role vs capability vs charter.** ADR 070 already separates them; what does the _assignment_ UX
   look like (`musterd role assign`? seat-file edit? template at provisioning only)? Can a seat hold
   more than one role?
2. **Enforcement shape for the infra guardrail.** Which verbs are "infrastructure" (service
   restart/refresh/install, reset, reload, migrations…)? Enforced where — CLI-side refusal, daemon-side
   capability check, or both? What is the escalation path (`request_help` to the platform role, with
   what SLA/wake behavior)? And the leniency ramp: warn-first → require `--force` + audit → refuse.
3. **Routing by role.** "Ask the platform agent" wants role-addressed acts (send to _the role_, not a
   named seat) — today acts address members/team/broadcast. Does a role become an addressable pool
   (the existing role-pool claim `<role>-<n>` suggests yes)?
4. **The steward's migration** from GitHub Action to resident seat (residency increment already
   reserved for this) — is that the template every "standing role agent" follows?
5. **Relation to the standalone harness** (`own-harness`): roles must be harness-independent — the
   same role assignable whether the seat runs on Claude Code, Codex, Cursor, or musterd's own future
   harness. The template _rendering_ is per-harness; the role _identity_ is not.
6. **Humans and roles.** The human-role-reevaluation item is adjacent: do humans hold roles from the
   same library (owner, approver), and does the guardrail bind them too?

## Non-goals (for the eventual design, per the owner)

- Not now: this is a capture. The full brainstorm/design session decides everything above.
- No new protocol power for any role — a role is charter + capabilities on an ordinary seat.
- No hard enforcement while the team's daily work _is_ the platform; leniency until the platform
  itself is stable enough that most agents don't need to touch it.
