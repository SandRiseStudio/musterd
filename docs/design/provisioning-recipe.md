# Provisioning recipe — role templates & the local onboarding flow (design)

> **Status: Phase 1 partially built** ("roles provision tools" — the Role JSON template, built-in seed library, Claude Code MCP-server provisioning, uninstall manifest, charter injection, and init wiring; ADRs 029–030). The identity/claim/governance half (§5–§6) is still design, v0.3-gated. The detailed design under **ADR 026** (harness tool environment / two universes), governed by **ADR 027** (non-invasive coexistence) and **ADR 028** (compose, don't capture). The wire-level seat/claim handshake is `SPEC.md` Appendix A.3; the governance/auth model (seats, grants, capabilities) is `membership-model.md`. **This doc owns** the *provisioning recipe* (what a Role template is + how it renders into a harness) and the *local onboarding/claim experience* (`init`-once, claim-on-first-use). It activates with the harness-provisioning work on `ROADMAP.md`.

## The spine

Four principles hold the whole design together; every decision below falls out of them:

- **Claim-on-first-use** — a session gets its identity when it's used, not when it's configured.
- **`init` is once per folder** — onboarding, never how you add an agent.
- **Recommend, don't require** — worktrees and richer tooling make musterd better; it works fully without them (the ADR 014 "one dim line, never nag" pattern).
- **Compose, don't capture** (ADR 028) — defer to git, the harness, and the MCP ecosystem; add only the coordination layer they lack.

## 1. A Role is a provisioning template (one file, two projections)

A **Role** is a harness-agnostic template — authored once, shareable, living in `.musterd/roles/*` (plus a shipped built-in set). At use-time it *projects* into two places:

```
            role template  (authored once; the reproduction unit)
                  │
      ┌───────────┴────────────┐
      ▼                        ▼
 SERVER role record       LOCAL harness config
 (identity half:          (harness half: MCP
  role, capacity,          servers, scopes,
  charter, capabilities)   permissions)
 — musterd ENFORCES        — adapter PROVISIONS into
   & projects (A.1)          THIS machine's harness
```

```yaml
# .musterd/roles/backend.yaml   (or a shipped built-in)
role: backend
capacity: 2                       # unnamed seats → backend-1/2 (pooled); name them for charter+memory
charter: |                        # the LENS — served at claim AND written to AGENTS.md
  Own the server + data layer. Small, tested changes.
  status_update at task start/finish; request_help when blocked; resolve threads you finish.

capabilities:                     # → SERVER record; musterd ENFORCES
  can_message: team
  visibility_level: team
  can_flag_urgent: false

tools:                            # → LOCAL harness; adapter PROVISIONS (musterd does NOT enforce)
  resource_scopes: [packages/server/**, packages/protocol/**]   # DECLARED (coordination, not a sandbox)
  mcp_servers:                    # concrete entries, ${ENV} for secrets, placed per-harness
    - { name: supabase, command: npx, args: ["-y","@supabase/mcp"], env: { SUPABASE_TOKEN: "${SUPABASE_TOKEN}" } }
  permissions:                    # provisioned additively (merge); NOT a folder clamp
    allow: [edit, read, "bash(pnpm test*)"]
    ask:   [bash]
```

The **server stores only the identity half** (what it enforces + projects to the roster). The **`tools:` block never goes to the server** — musterd-server stays the authority on *capabilities*, not a registry of harness tooling.

## 2. Two universes (ADR 026)

- **Universe 1 — musterd's own acts** (`team_*`): governed by `can_message` / `can_flag_urgent` / `can_observe` / `visibility_level`, **enforced server-side**.
- **Universe 2 — harness tools** (edit/bash/web/other MCP servers + repo scopes): musterd **provisions** (write-time, additively) and **declares** (run-time, for coordination + audit), but **does not enforce** — enforcement is the harness/sandbox (Principle 4). Provisioning is a starting point, **not a security boundary**.

## 3. The built-in role library — a seed, not a catalog

musterd ships a small set of archetypes (`generalist`, `reviewer`, `backend`, `frontend`, `docs`) to teach the shape and give a one-command start. It is **not** the authoritative catalog of all roles, and it bundles no opinionated stacks that duplicate ecosystem conventions.

- Charters stay **lens-not-résumé** and minimal (`human-agent-dynamics.md` §74).
- MCP entries are **referenced, not owned** — musterd points at ecosystem servers; it never hosts or version-manages them.
- Users author their own in `.musterd/roles/`. A shared/community registry may exist later, but **musterd doesn't own or gatekeep it**.
- **`generalist` (the no-role default) gets nothing extra** — only the musterd MCP server + a bare charter. Tooling is something you opt into by choosing a richer role.

## 4. Rendering a template into each harness

The entry shape is near-standard — musterd's `McpServerEntry { command, args, env }` (`packages/cli/src/onboard/mcpEntry.ts`), and the `{ mcpServers: { name: {...} } }` JSON map is the de-facto standard shared by Claude Code and Cursor; Codex uses the same fields in TOML. So each adapter's job is **placement + format**, not semantics:

| Harness | Native target | Adapter writes via |
|---|---|---|
| Claude Code | `claude mcp add` (scoped) / `.mcp.json` | **prefer the CLI** (forward-compat; today's path), else merge the file |
| Cursor | `.cursor/mcp.json` | merge the `mcpServers` map |
| Codex | `~/.codex/config.toml` | merge `[mcp_servers.*]` |

**Adapter contract — `render(entries, scope)`:** prefer the harness's own CLI where one exists; **merge additively** (ADR 027 — never clobber a user's existing servers); **record what was added** so it can be removed exactly (closing ADR 027's uninstall gap).

**Scope + secrets (the load-bearing rule):**
- The **identity-bearing musterd entry** (carries the agent token) is **per-user / local** and gitignored — never a shared file (today's `-s local` is already correct).
- Role **tool-servers default to per-user / local scope too** — musterd stays a guest, not editing shared/checked-in harness files. An explicit **`--shared`** (or prompt) opt-in writes them into the project `.mcp.json` for a team that wants shared tooling.
- **Secrets are always `${ENV}` references**, never inline.
- **Reproducibility lives in the checked-in role template** (musterd's *own* file), not in a musterd-edited shared `.mcp.json`: a teammate reproduces "backend" by provisioning the same template locally.

## 5. `init` is once; agents arrive by claim-on-first-use

| Action | How | Command? |
|---|---|---|
| Set up musterd in a project | `musterd init` — wire the harness, join/create the team, seed the primer, set the folder's **claim policy** | **once per folder** |
| Add an agent in that folder | open a new session → connects **unclaimed** → assign it ("you're Ada") or it grabs the next open role seat | **none** |
| Pre-define named seats/roles | `musterd team add` / `role` verbs | optional |
| Set up a new worktree/project | `musterd init` *there* (that folder's first run) | once per new folder |

- `init` writes a **claim policy**, not a fixed identity. Re-running it is never how you add a teammate; it stays idempotent (repoints, never duplicates) but you never *need* to.
- **Folder claim policy = `MUSTERD_CLAIM`** (resolved via the ADR 018 env→binding ladder): **unset** → *assign-in-chat* (the editor default); **`seat:Ada`** → solo bind; **`role:backend`** → pool. **Autojoin fires ⇔ a default claim exists.**
- **Locally, claiming auto-mints the seat** (naming "Ada" provisions + claims it). The grant/approval governance (`membership-model.md`) layers on only when the team leaves localhost — frictionless local, secure path additive.
- **Uniform rule:** *shared folder ⇒ claim-on-first-use (no re-init); worktree-per-agent ⇒ each is its own quick `init`.*

## 6. The claim tool surface & explicit claiming

- **`team_join` overloaded** (not a second tool): `{ as:"Ada" }` claims a named seat (minted locally if absent); `{ role:"backend" }` claims the next open role seat (result returns the handle, e.g. `backend-2`); `{ }` uses the folder policy. **The join result returns the assigned identity + charter** — a freshly-claimed session learns who and what it is.
- **Conflict semantics:** a named seat held by **another live session** → `claim_conflict` (protect a teammate's identity; offer free seats + hint, A.3). Your **own** reloaded/orphaned session → **newest-wins** (ADR 017). Free or in-grace → re-occupy.
- **Explicit claiming is human-driven, three layers, degrading gracefully** (never depend on the agent self-claiming — the ADR 012 flaky path — nor on harness UI):
  - **L1 — picker:** MCP **elicitation**, where the harness supports it. Progressive enhancement only.
  - **L2 — `musterd claim <name>` / `--role <x>`: the universal floor.** Needs only musterd's own daemon; works in any harness.
  - **L3 — pre-set** the seat in the binding before launch → auto-claim.
- **Unclaimed = a pending presence** keyed by `(team, workspace, connId, driver)` — reachable but holding no seat; `team_send`/`team_inbox_check` refuse while unclaimed. `musterd claim` matches the pending session for this workspace; with several it **lists them and you pick** (default), or `--for <claim-code>` disambiguates deterministically (the code shows in the session's first output).

## 7. Worktrees — recommend, don't require

musterd works fully in a plain shared folder, where per-role tooling degrades to **declared scopes + charter** (coordination, not enforcement). A worktree-per-agent gives **real** per-role tool permissions for free. Surface it the ADR 014 way: **one dim, non-moralizing line, shown once, never repeated** — *"musterd gives each agent stronger isolation in its own git worktree — works fine without one."* Never block; never nag.

## Settled vs open

**Settled (this brainstorm):** template shape + two homes; concrete MCP entries (no handle registry); built-in seed + `generalist`=nothing; per-user/local default with `--shared` opt-in; secrets `${ENV}`; reproducibility via the template; `init`-once + claim-on-first-use; `team_join` surface + `MUSTERD_CLAIM`; three-layer explicit claim; worktree recommend-not-require.

**Settled (Phase 1 build, ADRs 029–030):**
- **Template file format** — user-authored templates are **JSON** (`.musterd/roles/<name>.json`; no runtime-dep, unlike YAML — hard rule #6); the charter accepts a string *or* an array of lines. Built-ins ship **in-source** (validated through the same parser), because a plain-`tsc` build copies no JSON assets. **ADR 029.**
- **Uninstall tracking format** — a versioned **`.musterd/provisioned.json`** manifest records the MCP server *names* musterd registered (union across re-provisions), so a future `musterd uninstall` removes exactly those and nothing the user added. No secret (names only) → not gitignored. **ADR 030.**

**Built in Phase 1:** Role JSON schema + zod parser; the built-in seed library; the **Claude Code** renderer (`provision()` → `claude mcp add -s local`, per-server idempotency, `${ENV}` passed verbatim as a reference — Claude Code expands `${VAR}`/`${VAR:-default}` at launch, musterd never resolves/bakes it; **permission defaults merged into `.claude/settings.local.json`** additively); the **Cursor** renderer (MCP servers merged into `.cursor/mcp.json`; Cursor has no managed allowlist, so permissions degrade to declared/charter); the manifest (servers **+ permissions**); charter → `AGENTS.md` (additive, reuses `upsertPrimer`); init's role step (`generalist`=nothing extra; identity unchanged); **`musterd uninstall`** — per-folder reversal that consumes the manifest to remove exactly what init added (role servers + permissions, the musterd server, the primer block) and clears local `.musterd/` state (the member stays on the roster — server-side removal is v0.3).

**Open / fast-follow (not built):** the **free-text role label vs. role template** unification — today an agent's roster/primer role is a free-text label set independently of which template provisions its tools, so the two can drift. The fix (template pick drives the label; free-text only as fallback/override) is **deferred until claim-on-first-use lands**, since that flow also assigns roles and is the right place to settle it; the human `init`/`createTeam` role prompt stays free-text (no template for humans). • the **Codex** renderer — Codex's MCP config is global TOML (`~/.codex/config.toml`), which collides with the per-user/**local** scope rule (ADR 027) and needs a TOML write strategy + a full Codex adapter (no `configure` exists yet); deferred to its own slice. • `resource_scopes` stay **declared-only** (coordination, not a sandbox — ADR 026 §4). • whether `role create` round-trips a built-in into an editable `.musterd/roles/*`; how charter injection updates a *running* session (vs next session) on a re-claim. (All the v0.3-gated identity/claim/governance work — seats, the claim handshake, grants, server-side capability enforcement — remains §5–§6 / SPEC Appendix A, future.)
