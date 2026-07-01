# 080 — Committed launch spec: a clone self-wires without a manual `musterd init`

- Status: accepted
- Date: 2026-07-01

## Context

ADR 060 named a decoupling and deliberately left half of it unsolved:

- **The _intent_ to be a musterd agent is committed.** The `AGENTS.md` `musterd:start` primer marker
  (ADR 012) travels with every checkout.
- **The _wiring_ is machine-local and secret-bearing.** `claude mcp add -s local` (ADR 027) writes the
  team agent key (`mskey_`) inline into `~/.claude.json`, and `.musterd/binding.json` (which holds the
  key + a `grant`) is the one thing `.gitignore` carves out (`**/.musterd/binding.json`, ADR 058).

So a fresh clone/worktree has the primer but no MCP server and no key. ADR 060 verifies-not-assumes
(the SessionStart hook checks `claude mcp get musterd` before claiming auto-join) and its stated
non-goal was: _"auto-registering the server from the committed marker would require a secret-free,
env-referenced entry — a separate change to the binding model."_ This ADR is that change.

## Decision

**Split the workspace binding into a committed, secret-free launch spec and the local secrets.**

- **`WorkspaceSpecSchema` (`packages/protocol/src/binding.ts`)** — `{ server, team, surface, claim }`,
  the launch fields that carry no secret. `BindingSchema` is now this spec _extended_ with the optional
  secrets `agent_key` + `grant`, so the wire format is unchanged. The spec is written to
  `.musterd/workspace.json`, which — unlike `binding.json` — is **not** gitignored (ADR 058 already
  commits the rest of `.musterd/`), so `git add`ing it makes the repo self-wireable. Writers
  (`saveWorkspaceSpec`) `WorkspaceSpecSchema.parse` their input, so a secret can never leak into the
  committed file even if a full Binding is passed. `musterd init` and `musterd agent` write it
  alongside the gitignored binding.

- **`musterd wire` — the headless counterpart to `init`.** Reads `.musterd/workspace.json`, resolves
  the key from **local** sources only (`--key` → `MUSTERD_AGENT_KEY` → the machine's global
  `config.agentKeys[team]`), and registers the MCP server for the folder (idempotent — `configure`
  does `mcp remove` then `mcp add`). No prompts. It **registers tools only** — it does _not_ set
  `MUSTERD_AUTOJOIN`, so a shared repo cloned by many never has every clone auto-claim the same seat;
  the session stays dormant until it joins explicitly (`--autojoin` opts a personal worktree into
  claim-on-launch). Wiring (make the tools available) is deliberately distinct from claiming a seat.
  If no key resolves, it still registers the server (tools available) and warns that claiming will
  need a key or admin approval.

- **The adapter reads the spec as a base.** `loadMcpConfig` resolves the non-secret fields
  `env > binding.json > workspace.json`; secrets (`agent_key`, `grant`) come **only** from env or
  binding.json, never the committed spec. So a clone whose only musterd file is the committed spec,
  plus an env-supplied key, resolves its full identity.

- **The SessionStart hook points at the self-wire.** When `claude mcp get musterd` fails, the hook
  (ADR 060, now global) checks for `.musterd/workspace.json`: present → "run `musterd wire` (no
  prompts), then reload"; absent → the existing "run `musterd init`". The hook itself never runs a
  mutating command — it only names the one-shot to run. (A newly-registered MCP server isn't live until
  the session reloads, so the reload step is always named.)

## Consequences

- A fresh clone/worktree self-wires with a single no-prompt `musterd wire` (or is told to, by the
  hook) instead of a full interactive `init` — the ADR 060 non-goal, unblocked.
- The token-out-of-tree posture (ADR 027 / 060) is preserved and made explicit: the committed spec is
  secret-free _by construction_ (parse-strips secrets), and the key stays in env / the gitignored
  binding / the 0600 global config. A security test asserts no `mskey_`/`msgr_` reaches the committed
  file.
- The committed `claim` policy is the author's choice and carries a shared-repo caveat: `seat:<name>`
  self-wires a _personal_ worktree as that seat; a repo cloned by many should commit `role:<pool>` or
  `chat` so clones don't collide on one seat (documented; no code gate — `wire`'s no-autojoin default
  is the safety net).
- A truly cold machine (never joined the team, no key anywhere) can `wire` the _tools_ but not claim —
  it needs a key (`MUSTERD_AGENT_KEY`) or an admin grant first. That boundary is correct: the launch
  config is committable; the credential is not.
- Composes with ADR 018 (binding file), ADR 058 (committed `.musterd/`), ADR 060 (verify-don't-assume;
  this supersedes its non-goal), ADR 075/077 (agent key + claim/request lane).

## Observability & Evaluation

**Traces** — `wire` is a local, read-only-to-the-team CLI setup step; it registers a harness server and
writes local files, emitting no coordination acts and joining no team, so no new spans on the team-task
timeline. Its signal is an exit code + `--json` (`mcpRegistered`, `keyResolved`, `autojoin`).

**Eval** — success metric: the rate of fresh checkouts that reach a working `team_*` toolset via a
single `wire` (vs a manual `init`) — target: every checkout whose machine already holds the team key
self-wires with no interactive step. **Dataset**: fresh-clone onboarding runs across the provisioned
corpus. **Baseline**: today's flow, where every fresh checkout requires an interactive `init`. The
`wire` command's own correctness (spec + key → registered idempotently; keyless → registered + warn; no
spec → clear error; secret never committed) is covered by `wire.test.ts`, and the adapter's spec
fallback by the mcp `binding.test.ts`.

**Experiment** — named, not built: once batond exists, compare onboarding-to-first-`team_join` time and
success for fresh checkouts under `wire`-from-committed-spec vs manual `init`.
