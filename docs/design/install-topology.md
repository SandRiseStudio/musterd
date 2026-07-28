# Install topology — the team home is where the human stands

**Status:** design accepted by nick 2026-07-28 (this session); implementation lanes open, unclaimed.
**Author:** miley, from the 2026-07-28 dogfood session that surfaced every gap below, live.
**Companion ADRs:** two ride the implementing PRs — the _credential re-issue_ ADR (increment 3) and
the _team home_ ADR (increment 4). Numbers are picked at landing time against origin/main; ADR 171
was taken by a different decision (#448) between this doc's drafting and its first commit, which is
the collision trap doing its job.

---

## 1. Why this document exists

Every primitive of a working musterd install shipped separately and works: the packaged binary
(ADR 156 — brew tap, npm, Node ≥22 gate), the daemon as a service, `team create`, agent worktrees
(ADR 065), folder bindings (ADR 018/036), the committed launch spec (ADR 080), the durable roster
(ADR 058). What never shipped is the **model that composes them** — the answer to a founder question
as basic as _"where does a user install musterd, where does a team live, and do I, the human, have a
workspace?"_

The absence is not cosmetic. In one evening of dogfooding the writable board and the sign-in handoff
(ADR 170), the unstated topology produced, in order:

- a binding at the daemon's own checkout that **claims the human seat `nick` but authenticates with
  the team agent key** — occupied successfully at claim time, then 403'd on every subsequent request
  (`the team agent key may only act as an agent seat`);
- the discovery that nick's `mscr_` credential for the dogfood team exists **nowhere on his
  machine** — and that musterd has **no way to re-issue it**;
- the discovery that the human has **no workspace at all**: eleven agent worktrees, zero for the
  person the ADR 145 arc spent months making a peer.

Each of these is a seam between two shipped primitives. This document states the topology, names the
seams as concrete work (six lanes, listed in §9), and records the design decisions nick made.

## 2. The four layers

musterd's install topology has four layers, each with a distinct on-disk anchor and lifetime:

| Layer         | Scope                       | Anchor                                                                                     | Provisioned by                                     |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **Platform**  | per machine                 | the binary on PATH + `~/.musterd/` (config.json, musterd.db, host-registry.json, live/web) | `brew install musterd` + `musterd service install` |
| **Team**      | per daemon                  | a row in the daemon's DB; optionally a git roster via `team export` (ADR 058)              | `musterd team create`                              |
| **Project**   | per repo, **many per team** | the repo + its `.musterd/{binding,workspace}.json`                                         | `musterd init` / `musterd wire`                    |
| **Workspace** | per seat per repo           | a sibling worktree `<repo>-<seat>` (agents) · the **team home** (humans, §4)               | `musterd agent <name>` · `musterd human <name>`    |

Two rules orient everything:

- **A daemon hosts many teams; a team lives on exactly one daemon** (ADR 039). "One team = one
  daemon" is a statement about the team, not the daemon.
- **A team is a standing roster, not a project** — it outlives any task, session, or repository.
  Projects are wired _to_ a team; a team is never "in" a project.

And one sentence carries the workspace layer:

> **Agents stand in worktrees; the human stands in the team home.**

An agent needs a worktree because it writes code in isolation. A human needs a place where their
_identity resolves_ — where `musterd board`, `musterd inbox --watch`, and `musterd send` are simply
_them_, no `--as`, no pasting. Those are different needs, and pretending the second is a variant of
the first is how the human ended up with no floor to stand on.

### Why the dogfood machine scrambles this

On the machine musterd is built on, the _project_ is musterd itself: `/Users/nick/agents` is at once
the project repo, the daemon's source, the binary's install location, and the base of every
workspace. Layers 1, 3, and 4 share one path. No end user will ever have this topology — it is the
compiler-compiling-itself case — and most confusion about "what should be named what" dissolves once
the layers are separated. (The optional cleanup for this machine is an operator runbook, Appendix A
— explicitly not product code.)

## 3. Many teams × many projects — the matrix

Both multiplicities are first-class, and they are independent:

- **One human, many teams.** The config already supports it: `identities` is keyed per team, the
  ADR 059 vault holds many `(team, name)` pairs, and each folder's `binding.server` may point at a
  different daemon. The sharp edge is `config.current` — a single machine-global "last team I
  touched" that ambient commands default to. The team home (§4) is the better answer: **which team
  you are acting on is answered by where you are standing**, not by what you touched last.
  `~/musterd/revive` beside `~/musterd/acme` — walking between teams is `cd`.
- **One team, many projects.** Doctrine since the README ("reuse the same team across folders"), and
  `wire`/`agent --path` handle it cleanly today. Two thin spots are in scope as lanes:
  - `init`'s team menu offers only _this folder's team / the machine's current team / create new_ —
    wiring a second repo to a known non-current team has no interactive path, and the fallback it
    does offer (create a new team) is the destructive one. The menu must offer the teams the vault
    already knows. (Part of lane L-docs-settle, §9.)
  - Lanes carry a `project` field that **nothing populates** — every lane on every team is
    `project='default'`, which silently makes surface-contention checks team-wide instead of
    per-repo. See §7. (Lane L-project.)

## 4. The team home

**A per-team directory, default `~/musterd/<team>`, recorded in a new config key
`teamHome: Record<slug, absPath>`.**

What lives in it:

- **The human's binding** — `.musterd/binding.json`, 0600, carrying `claim: {mode:'seat',
name:<human>}` and their `mscr_` credential. This is the load-bearing item: identity resolution
  (`gather()`) already reads bindings first, is prefix-agnostic about the key, and requires no git —
  so every read/act command works bare from the home, as the human. It is exactly the shape
  `team create` already writes for the creator; the home just gives it a _designated_ place instead
  of "wherever create happened to run."
- **The exported roster** (`team.toml`, `seats/*.toml`), _iff_ the team is file-backed. `teamHome`
  and ADR 058's `rosterHome` are deliberately distinct keys — `rosterHome` is the cutover signal
  that makes files roster-authoritative, and creating a human workspace must never silently flip a
  db-only team into file-backed mode. They compose: when both exist they should be the same folder,
  and `team export` defaults `--to` into the team home. This also settles the multi-repo question
  `migration-bootstrap.md` deferred: the roster's home is the _team's_ home, not any project repo's.
- **Nothing else, yet.** Reserved (named now, built when pulled): team memory exports, notes, seat
  session labels. Explicitly never: a code checkout. Projects are layer 3 and live wherever they
  live; the home is layer-2 ground, which is also why it needs no git.

`~/musterd/` is the natural roof over all of a human's teams without being a config concept itself.

## 5. `musterd human <name>` — the provisioning verb

The deliberate mirror of `musterd agent <name>`; the pair _is_ the model. `agent` mints a seat and
stands it in a worktree; `human` mints (or recovers) a credential and stands the person in the team
home. Today's `team add --kind human` prints a `musterd join …` line and stops — `human` is that
line, executed, with a floor under it.

The composition (all glue over existing parts; the only new server surface is the re-issue route,
§6):

1. Resolve team (`--team` → `config.current`).
2. Resolve home (`teamHome[slug]` → `--home` → default `~/musterd/<team>`, mkdir -p). Refuse loudly
   if the directory already carries a _different_ team's `.musterd/` — never write a binding into
   someone else's floor.
3. Ensure the member: not on roster → `POST /members {kind:'human'}` (mints, shown once) · on roster
   with a vault credential → reuse · on roster with **no** credential → offer the re-issue rotate
   (§6) behind an explicit confirm, since it invalidates the old secret wherever it lives.
4. `rememberIdentity` + `identities[team]` → `saveBinding(home)` → self-claim (a credential claiming
   its own seat is self-authorizing, ADR 077) so the roster shows the human immediately.
5. Record `teamHome[slug]`. Print the two commands the floor exists for: `musterd board`,
   `musterd inbox --watch`.

Idempotent by construction: a second run reuses everything and clobbers nothing.

**On the name.** `me` was rejected (presumes one identity; reads as a query; cannot provision a
teammate). `member`/`teammate` are wrong — agents are both. `user` is the register musterd
explicitly rejects (humans are peers, not users of the agents' system). `human` is the protocol's
own kind noun (`kind: 'human'`, `--kind human`, jade-agent/rose-human on every surface); the slight
clinical ring of the pair `agent`/`human` is the product's fundamental dichotomy being taught at the
command line. Recorded for the team-home ADR, where it can still be vetoed.

## 6. Identity integrity — the two seams the claim path exposed

**(a) The claim path must enforce seat kind.** `authByAgentKey` states the invariant — _"the shared
team agent key must NOT be able to act as a human seat"_ — and enforces it on every request. But
**occupancy itself doesn't**: the HTTP claim route's agent-key branch (keyHash match →
`authenticatedMember = null`) resolves any target seat with no kind check, and the WS claim's grant
and request-approval branches share the hole (only the ADR 146 re-seat branch checks). So an
`mskey_` successfully occupies a human seat, gets a grant, marks presence, writes a binding — and
every subsequent request 403s. That is precisely the dead `nick` binding found on 2026-07-28,
written by `init`'s "Activate an existing member" intent, which hands `config.agentKeys[team]` to
`claimCommand` for any target.

Fix shape (lane L-claim-kind): one invariant, stated once — **an agent-key-authenticated claim may
only occupy an agent seat** — enforced _after_ target resolution (so role-targets that resolve to a
human seat are caught) and _before_ the grant/request branches (so an admin can never be asked to
approve a poisoned claim, and no pending-request row leaks). Refusal message reuses
`authByAgentKey`'s wording plus the repair: `musterd join <team> --as <name> --key <mscr_…>`.
No ADR: this enforces a decided posture (ADR 069/075); it is a bug fix.

Companions (lane L-doctor): `init --check`/doctor gains _"this binding claims seat X; the roster
says X is human; the binding carries an agent key"_ (degrading honestly to "cannot verify" when the
daemon is down), and `init`'s 'existing' intent prefers a vault `mscr_` when the target is a human
seat.

**(b) A lost human credential must be recoverable.** `credential_hash` is a single column;
`mintCredential` overwrites it; its only call sites are team-create and new-member add;
`POST /members` conflicts on a live member; there is no CLI verb. A human who loses their `mscr_`
is unrecoverable short of DB surgery — the state nick is in on his own dogfood team, which blocks
the very `musterd board` flow ADR 170 built (its premise, "the CLI already holds your credential,"
is false on the founder's machine — the first datum against that design's assumption, honestly
earned).

Decision (pre-registered here; the credential-re-issue ADR rides lane L-credential):

- **Rotate-in-place.** `POST /teams/:slug/members/:name/credential/rotate`, mirroring the agent-key
  rotate template: mint, audit (`credential.rotate`), shown once, old secret dead at next claim
  (live sessions ride out, same as agent-key rotate). The two-credential schema ADR 170 deferred
  stays deferred — ADR 170 solved the scoped-web-credential need with a nonce, and "I lost it" is
  exactly what rotation serves.
- **At the `authProvision` bar** (localhost unauthenticated; admin credential required off-host —
  ADR 134). Admin-only would be circular: the primary caller has lost the very credential admin auth
  would demand. Re-minting for an existing human is not a more powerful act than minting for a new
  one, which already sits at this bar. The residual risk — any local process can rotate any human's
  credential — is ADR 134's accepted boundary, and rotation is self-announcing (audit row + the old
  secret stops working).
- **CLI: `musterd team credential <name>`** — prints shown-once; when the local config holds an
  identity for `(team, name)` it repairs the vault and `identities[team]`, and when the cwd binding
  names that seat it rewrites the binding — so ADR 170's handoff works immediately after a rotate,
  with zero pasting.

## 7. Lane `project` derivation (in scope, per nick)

Lanes have carried a `project` field since ADR 083 — _"contention is checked within a project, never
across"_ — but nothing derives it: the CLI takes only an explicit `--project`, the MCP tool
describes the default, and the server stamps `'default'`. Result: on real teams, **every lane is one
project and surface-contention warnings are team-wide** — `packages/web/**` in this repo "overlaps"
`packages/web/**` in any other repo the team touches.

Design (lane L-project): derive `project` from repo identity at lane-open time — default **the
basename of the git toplevel** of the opener's workspace (the MCP adapter already derives a
per-session workspace label from exactly this; it just never feeds `project`), overridable by
`--project` / `MUSTERD_PROJECT`, with non-git folders staying `'default'`. Two consequences to
state honestly in the implementing PR:

- **Contention semantics change the day this lands**: per-project overlap checks become real, so
  same-glob lanes in different repos stop warning at each other. That is the intended meaning
  finally taking effect, not a regression — but it must be named, because warn-counts will drop.
- **Back-compat**: existing lanes stay `'default'`; no migration rewrites history. Mixed-era teams
  will briefly have old-'default' lanes warning against everything, which resolves as lanes close.

## 8. Explicitly parked

- **Checkout rename** (`/Users/nick/agents` → `~/musterd`, making every worktree `musterd-<seat>`):
  operator migration, zero product delta — welded to LaunchAgent plists, 13 worktree registrations,
  the repo-root-keyed MCP entry (ADR 143/165), and ~23 registry binding paths. Appendix A is the
  runbook; run it after the team home exists so a botched step is recoverable with `musterd human`.
  The product-side fix for the _feeling_ behind it is this document: kind lives in the roster, not
  in folder names.
- **Multi-device humans** — signing in on a machine that isn't the daemon host. Owned by ADR 170's
  pre-registered `off_machine` counter-signal; requires the bounded-credential schema change; not
  smuggled in here.
- **Remote join (v0.3 P4) and the hosted relay** — deferred on the roadmap, unchanged by this arc.
- **/live for packaged installs** — named out of scope by ADR 156; the biggest remaining
  install-topology hole, tracked there, not here.

## 9. The lanes

Six, opened unclaimed with surface globs (any seat may pick one up; L-credential unblocks the
founder dogfood soonest and should go first after the bug fix):

| Lane          | Surface                                                                      | Content                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| L-claim-kind  | `packages/server/src/transport/{http,ws}.ts`                                 | §6(a): the kind guard on both claim surfaces; through-DB tests incl. no-request-row-leak, role-resolution, ADR 077/146 regressions |
| L-doctor      | `packages/cli/src/onboard/init.ts`                                           | §6(a) companions: the mismatch diagnostic + 'existing'-intent key preference                                                       |
| L-credential  | `packages/server/src/transport/http.ts`, `packages/cli/src/commands/team.ts` | §6(b): rotate route + `team credential` verb + its ADR                                                                             |
| L-team-home   | `packages/cli/src/{config.ts,commands/human.ts}`                             | §4–5: `teamHome` key + `musterd human` + its ADR; acceptance = `stageSigninHandoff` succeeds from a fresh home                     |
| L-project     | `packages/{cli,mcp,server}` lane-open paths                                  | §7: derivation + overrides + the contention-semantics note                                                                         |
| L-docs-settle | `docs/**`                                                                    | architecture trees, migration-bootstrap cross-link, primer/guides mention of the agent/human verb pair                             |

---

## Appendix A — operator runbook: renaming the dogfood checkout (optional, this machine only)

Goal: `/Users/nick/agents` → `/Users/nick/musterd`, worktrees becoming `musterd-<seat>`. Not product
code; run at a quiet moment, after L-team-home lands.

1. Announce on the team; stop the services: `musterd service stop` (daemon, `-live`, `-host`).
2. `git -C /Users/nick/agents worktree list` — for each seat worktree:
   `git worktree move /Users/nick/agents-<seat> /Users/nick/musterd-<seat>`.
3. `mv /Users/nick/agents /Users/nick/musterd`; then `git worktree repair` from the moved root and
   each moved worktree (repairs both directions of the gitdir links).
4. Rewrite paths in `~/.musterd/config.json` (`bindings` keys, any `rosterHome`/`teamHome` values)
   and in `~/.musterd/host-registry.json` (workspace dirs).
5. Re-key the harness MCP entries: the Claude Code entry is keyed by repo root (ADR 143/165) — in
   one moved worktree run `musterd init --check --fix` (or re-run the documented `claude mcp`
   registration) so the family entry follows the new root; verify with `claude mcp get musterd`
   from two different worktrees.
6. `musterd service install` again (plists embed absolute paths); `service status` until healthy;
   verify `/live` and the LaunchAgent labels.
7. Every open terminal/session in a moved folder must `cd` afresh; live seats re-verify with
   `musterd whoami` + `musterd init --check`.

Abort-safe order: nothing before step 3 is destructive; if step 3 has run, the reverse `mv` +
`git worktree repair` restores the old world.
