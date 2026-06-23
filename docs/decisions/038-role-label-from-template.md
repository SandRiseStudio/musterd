# 038 — the role label is derived from the provisioning template at init mint-time

- Status: accepted
- Date: 2026-06-23

## Context

A Role is "one file, two projections" (provisioning-recipe.md §1, ADR 026): the template both names
the agent's **role label** (the SERVER identity half — shown on the roster + written into the
AGENTS.md primer) and provisions its **tools** (the LOCAL harness half). But in `musterd init` those
two were set by **independent inputs**:

1. a free-text **role label** prompt (`Role (optional)`, placeholder `backend`), passed straight to
   `addMember({ name, kind:'agent', role })`; and
2. a separate **role-template** select inside `provisionRole`, which ran *after* the member was
   already minted and provisioned the MCP servers + permissions + charter.

Nothing tied them together, so they could **drift**: you could type label `backend` but provision
the `frontend` template, or type nothing and provision `backend` — the roster said one thing, the
tools were another. The provisioning recipe specced the fix in one line ("template pick drives the
label; free-text only as fallback/override") but **deferred it until claim-on-first-use landed**.
That has now landed (ADR 032), so the hook is open.

## Decision

**The chosen role template drives the agent's role label; free-text is only an override/fallback —
derived client-side at mint time, with no wire change.**

### 1. Mint-time derivation, not a new endpoint

`init` now **chooses the role template before the member is minted** and derives the `role` label
from it, feeding the existing `addMember({ name, kind, role })` call. `addMember` already carries
`role` to the server (it is how `team add --role` and `claim --role` already set it), so deriving the
label this way needs **no wire change, no new role-update endpoint, and no SPEC bump**. ADR 032
already established that a claim assigns the seat's role at mint; this aligns `init` with that model.

A server-side role-update endpoint was **rejected**: there is no member-role mutation on the wire
today, and adding one would be an additive MINOR + SPEC bump + ADR for no benefit — the label is
knowable before the member exists.

### 2. Precedence + the override gate

The precedence is **explicit free-text override > template `role` > empty**, captured in a pure,
unit-tested helper `resolveRoleLabel({ template?, freeText? })` (kept out of the interactive `@clack`
flow). The UX around it:

- **A non-generalist template** settles the label to its `role`. The free-text prompt is **not**
  shown unconditionally; instead init offers an explicit **override gate** —
  *"Override the role label `backend`?"* (default: keep). Declining (the default) keeps the
  template-derived label — the common path is the drift-free one with one keystroke. Accepting opens
  a free-text prompt whose value overrides.
- **`generalist` / no template / an unloadable template** falls back to the same optional free-text
  prompt as before (which may be empty). Labelling is opt-in there — the ADR 028 "generalist gets
  nothing extra" posture extends to its label.

The override gate (rather than always prefilling an editable prompt, or silently skipping it) was
chosen so the override stays **explicit and deliberate** without adding friction to the default
keep-the-template-label path.

### 3. `claim --role` / `team add --role` are out of scope (already label-aligned)

`musterd claim --role <x>` already mints `<role>-<n>` with `role: <x>` — its label is already
template-named — and it deliberately does **not** provision tools (it is the harness-agnostic L2
floor; provisioning needs a detected harness, which lives in `init`). `team add --role` is an
admin/scripting path with the same already-aligned label. Neither is changed here. The seam is
explicit: **`init` is where a template both labels *and* provisions; `claim`/`team add` label
without provisioning.** Closing the provisioning half of `claim` would require harness detection in
the L2 floor and is left for a future decision.

## Scope

- **In:** `init` reorders template-pick before mint and derives the label; the pure
  `resolveRoleLabel` helper; the override gate; the `provisionRole` split into `selectRole` (step 4,
  pick + load) and `provisionRoleTools` (step 5a, provision the already-chosen template).
- **Out:** any server-side role mutation; the **human** creator-role prompt
  (`createTeam` / `init`) stays free-text — there are no human role templates; `claim`/`team add`
  provisioning; `resource_scopes` stay declared-only (ADR 026 §4).

## Consequences

- The roster + primer role an agent shows **always matches the template that provisioned its
  tools**, unless a human deliberately overrode it — "the role you see is the role you provisioned."
- No wire change: `SPEC.md` is untouched; the derivation is entirely client-side at mint.
- Moves the "free-text role label vs. role template" item from **Open / fast-follow** → **Built** in
  `provisioning-recipe.md`.
- The pure resolver is the natural unit-test target; the interactive flow stays a thin caller.
