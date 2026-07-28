# 176 — Agents stand in worktrees; the human stands in the team home

- Status: proposed — 2026-07-28. Authored by izzo (lane `01KYMY094VEP2XB0ZPPZ488DWX`). The design was
  pre-registered by miley in `docs/design/install-topology.md` §4–5; this ADR is that design written
  down where it can be argued with, plus the one call §5 deliberately left open (`config.current`),
  which nick settled in this session. Number **176** — next free above ADR 175 at landing time.
- Date: 2026-07-28
- Builds on: [ADR 065](065-agent-workspace-provisioning.md) (`musterd agent` — the worktree half of the
  pair), [ADR 018](018-workspace-scoped-identity.md) (the binding this stands on),
  [ADR 036](036-active-identity-to-act.md) (a folder is where identity resolves),
  [ADR 059](059-multi-identity-global-config.md) (many `(team, name)` pairs per machine),
  [ADR 058](058-durable-on-git-live-on-daemon.md) (`rosterHome`, deliberately a _different_ key),
  [ADR 075](075-p3.3-cli-claim-surface-migration.md) (the credential that authenticates the claim),
  [ADR 077](077-v0.3-p3.2-claim-handshake-and-request-lane.md) (a credential claiming its own seat is self-authorizing),
  [ADR 174](174-human-credential-recovery.md) (the rotate this reuses),
  [ADR 170](170-signin-handoff.md) (`musterd board`, whose premise this makes true by construction).

## Context

Every primitive of a working install shipped and works: the packaged binary, the daemon as a service,
`team create`, agent worktrees, folder bindings, the durable roster. What never shipped is the model
that composes them — and the gap has a shape: **musterd has a provisioning verb for agents and none
for people.**

The consequence is not cosmetic. `musterd agent <name>` mints a seat and stands it in an isolated
worktree, so eleven agents on the dogfood machine each have a folder where they simply _are_
themselves. The human has none. His binding therefore ended up wherever `team create` happened to
run, which on that machine was `/Users/nick/agents` — the daemon's own source checkout, where layers
1, 3 and 4 of the topology collide. Three failures follow directly from that, all observed on
2026-07-28:

- **Identity by accident.** nick is `nick` in exactly one folder on his machine, and only because a
  command was once typed there. Every other folder reads as nobody.
- **The wrong team by default.** With no home to stand in, "which team am I acting on" is answered by
  `config.current`, a machine-global _last team I touched_. On the founder's machine that value was
  `cookoff-gb2` — a finished experiment cell — while his real team had no entry in `identities` at
  all. A bare `musterd send` acted on a dead fixture.
- **The arc built for him was unreachable.** ADR 170's `musterd board` assumes the CLI already holds
  your credential. With nowhere designated to hold it, that assumption is false exactly where it
  matters most (ADR 174 restored the credential; this restores the place to keep it).

The asymmetry is not an oversight, it is an unstated model. An agent needs a _worktree_ because it
writes code in isolation. A human needs somewhere their _identity resolves_ — `musterd board`,
`musterd inbox --watch`, `musterd send`, with no `--as` and nothing pasted. Those are different
needs, and treating the second as a variant of the first is how the person the ADR 145 arc spent
months making a peer ended up as the only member of the team with no floor.

## Decision

**One sentence carries the workspace layer: _agents stand in worktrees; the human stands in the team
home._**

### 1. The team home is a real, named, recorded place

A per-team directory, default `~/musterd/<team>`, recorded in a new config key
`teamHome: Record<slug, absPath>`. It holds the human's `.musterd/binding.json` (0600) carrying
`claim: {mode:'seat', name}` and their `mscr_`. That is the load-bearing item and the only required
one: identity resolution reads bindings first, is prefix-agnostic about the key, and needs no git —
so every read and act works bare from the home, as that person.

`~/musterd/` is visible on purpose. It is the roof over all of a human's teams — `~/musterd/revive`
beside `~/musterd/acme`, and walking between teams is `cd` — without itself being a config concept.
The platform dotdir `~/.musterd/` holds machine state a person never opens; a home is somewhere they
stand, and hiding it would contradict the thing it exists to provide.

**`teamHome` is a distinct key from `rosterHome`, not a rename of it.** `rosterHome` is ADR 058's
_cutover signal_ — a team is file-authoritative iff it has one. Giving a person somewhere to stand
must never silently flip a db-only team into file-backed reconciliation. The two compose (when both
exist they should name the same folder, and `team export` should default `--to` into the home); they
do not merge. Explicitly **never** in the home: a code checkout. Projects are layer 3 and live
wherever they live.

### 2. `musterd human <name>` is the provisioning verb

The deliberate mirror of `musterd agent <name>`; the pair _is_ the model. It resolves the team,
resolves and creates the home, ensures the member, writes the binding, self-claims, and records what
it did. All glue over shipped parts — the only new state is `teamHome`.

Three properties are load-bearing rather than incidental:

- **Identity-free, like ADR 174's `team credential`.** Both member-add and credential-rotate sit at
  the `authProvision` bar (ADR 134). Requiring an active identity would be circular for exactly the
  person this command serves: their problem _is_ having no floor to act from.
- **Idempotent by construction.** A second run reuses the recorded home, reuses a credential this
  machine already holds, and clobbers nothing. A provisioning verb you have to think before typing
  is one people avoid typing.
- **A home belongs to one team.** Writing into a directory that already carries a _different_ team's
  binding is refused, and the occupancy check reads that one folder exactly — not `findBinding`'s
  walk up the tree, which under `~` would answer with an ancestor's team and refuse to write a
  perfectly empty home.

### 3. The credential has exactly three branches, and the destructive one is never implicit

Not on the roster → mint (`POST /members`, shown once). On the roster and this machine holds the
secret → reuse it. On the roster and this machine holds nothing → **offer** the ADR 174 rotate,
behind `--rotate` or an interactive confirm, never by default. The third branch is the state the
dogfood machine was in, and its only exit invalidates a secret that a possibly-absent person may
still hold. A recovery that helpfully destroys someone else's access is not a convenience.

### 4. `musterd human` sets `config.current`, and says so

This is the call install-topology §5 left open, and it has a real argument on both sides. §3 holds
that the home is the better answer to _which team am I acting on_ — location, not history — so
writing to the machine-global knob props up the thing the home is meant to replace.

**Decided: set it, and print it.** Provisioning your floor is the strongest statement of intent a
person can make about a team; a rule with no exceptions is easier to hold than a conditional one; and
leaving `current` alone means a bare command from outside any home still acts on whatever was touched
last — on the founder's machine, a dead experiment cell. So the home answers the question where you
are standing in one, and `current` is dragged into agreement for everywhere else. The write is
announced with its previous value on every run, never silent: a machine-global change made on the way
past is precisely the kind that should never be discovered later.

### 5. Being online is reported, not assumed

The command self-claims so the roster shows the person immediately (ADR 077: a credential claiming
its own seat is self-authorizing — no grant, no approval lane). But the claim happens _after_ the
home is written and durable, and a refusal is reported as its own line rather than failing the
provision or being swallowed. The floor existing and the seat being occupied are two different
facts, and a command that conflated them would either throw away good work on a transient daemon
error or quietly imply a presence that isn't there (ADR 173).

## Alternatives considered

- **`musterd me`.** Rejected: presumes one identity per machine (ADR 059 exists because that is
  false), reads like a query rather than a provisioning verb, and cannot provision a _teammate_ —
  an admin standing up a new person is the same act.
- **`user` / `member` / `teammate`.** `user` is the register musterd explicitly rejects — humans are
  peers, not users of the agents' system. `member` and `teammate` are wrong because agents are both.
  `human` is the protocol's own kind noun (`kind:'human'`, `--kind human`, on every surface); the
  slightly clinical ring of `agent`/`human` is the product's fundamental dichotomy being taught at
  the command line.
- **Reuse `rosterHome`.** One key is simpler right up until provisioning a person silently flips a
  db-only team into file-authoritative reconciliation. See §1.
- **A worktree for the human, like agents get.** This is the mistake the whole ADR names. It forces a
  repo on a layer-2 concern, and a human with three projects would need three identities' worth of
  binding thrash for one seat.
- **Extend `team add --kind human` instead of a new verb.** `team add` prints a `musterd join …` line
  and stops — it declares a member. The gap was never declaration; it was the floor under it. Making
  `add` create directories would give one verb two jobs and no good name for either.
- **Leave `config.current` alone (§4's other side).** Purer, and defensible — but it ships the exact
  confusion this arc exists to end, on the machine that produced the evidence.

## Security

- **No new bar.** `human` calls two existing routes at `authProvision` (localhost unauthenticated,
  admin credential off-host — ADR 134) and one claim authenticated by the credential it just
  obtained. It adds no route and widens no bar.
- **The secret's blast radius is unchanged and its location improves.** The credential moves from
  "wherever `team create` was typed" to a designated 0600 file. Fewer accidental copies, and a known
  place to audit or delete.
- **The destructive branch is gated.** A rotate invalidates another person's live credential, so it
  requires `--rotate` or an interactive confirm, and prints the consequence in both refusal and
  success paths. The audit row from ADR 174 still lands — rotation stays self-announcing.
- **One home, one team.** The refusal in §2 prevents one person's credential from being written over
  another team's floor, and the exact-folder read prevents an ancestor binding from being mistaken
  for the home's own.
- **No secret in the visible roof.** `~/musterd/<team>` is a normal directory; only
  `.musterd/binding.json` inside it is 0600, matching every other binding on the machine.

## Observability & Evaluation

**The claim.** A human on a musterd team should be able to act as themselves from a place they can
name, without `--as` and without pasting a secret — and should not have to know what `config.current`
is.

**Traces.** Three, all on existing channels. (1) `teamHome` per team in the config, beside the
`identities` / `knownIdentities` entries — together they are the machine-readable answer to "does
this person have a floor here", which is what increment 2's doctor check will read. (2) The `--json`
output of `musterd human` reports `minted` (`added` | `rotated` | `null`), `credentialFrom`
(`vault` | `binding`), `online`, `home`, and `previousCurrent` — enough to tell a fresh mint from a
reuse from a destructive re-issue, and to see the machine-global write it made on the way past.
(3) The ADR 174 `credential.rotate` audit row still fires for the third branch, so a re-issue reached
through this verb is exactly as visible as one reached directly.

**Eval.** Dataset: the one machine that produced the evidence, in the state it was actually in —
`nick` on `revive`, on the roster, credential in a folder binding and not the vault,
`config.current` pointing at the finished `cookoff-gb2` cell. Baseline, read off the ADR 020 binding
registry before the change: of the folders this machine had recorded a binding for on `revive`,
**exactly one** resolved as `nick` — `/Users/nick/agents`, the daemon's own checkout, and only
because a command was once typed there. Every other folder, including every agent worktree, resolves
as somebody else or as nobody, and `musterd board` from any of them signs in nobody. Pre-registered
acceptance: after
`musterd human nick --team revive`, from a shell whose cwd is `~/musterd/revive` and with no flags,
(a) `musterd status` names nick on revive, (b) `musterd board` stages the ADR 170 handoff with
nothing pasted — its premise now true by construction rather than by accident — and (c)
`config.current` reads `revive`. Run live at landing, not asserted. n=1 by construction and honestly
so: this team has one human, and the population of humans locked out of their own floor is him.

**Experiment.** None — no arm to compare and no population to split. The instrument is the config
state above plus the acceptance run; the one genuinely uncertain call (§4's `config.current` write)
is settled by argument, not by A/B, and its failure signal is written below rather than measured.

**How this ADR fails.** If `teamHome` accumulates entries that no human ever `cd`s into — i.e. people
keep acting from project repos with `--as` — then the home solved a topology problem nobody had, and
the honest follow-up is to make identity resolution project-aware rather than to keep provisioning
floors. A second, sharper failure: if the §4 `config.current` write turns out to surprise anyone (an
operator provisioning a home for _someone else_ and finding their own ambient team moved), the rule
was wrong and the conditional version §4 rejected is the repair.

## Increments

1. **The home and the verb** (this PR): `teamHome` config key + `defaultTeamHome` + `readBindingAt`;
   `musterd human <name>` with the three credential branches, the one-team refusal, the self-claim,
   and the announced `current` write; help catalog entry; unit coverage for each guard.
2. **Doctor sees the floor** (lane L2, open): `init --check` / doctor reports a team with no
   `teamHome`, and the dead-binding case §6(a) of install-topology names — the binding that claims a
   human seat with an agent key. Partly evaporates now that the home exists, which is why it follows
   rather than leads.
3. **`team export` defaults into the home** (small, follows naturally): when a team has a `teamHome`
   and no `rosterHome`, `--to` defaults there — the two keys composing rather than merging.
4. **Roll the model into the docs** (lane L-docs-settle): README + primer teach the pair
   `agent`/`human` as one model rather than two commands, and `init`'s team menu offers the teams the
   vault already knows.
