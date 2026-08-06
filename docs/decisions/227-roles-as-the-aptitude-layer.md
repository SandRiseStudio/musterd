# 227 — Roles as the aptitude layer

- **Status:** accepted — increment 1 (discovery: multi-role seat files + `roles[]` on the wire,
  role-file `summary`, `mergeRoleDefaults`, the `team_members` role filter, `musterd role assign`,
  migration v31, epoch 7) shipped 2026-08-04; increment 2 (the warn-only guardrail:
  `GET /teams/:slug/infra-gate` + the `infra.touch.warned` audit row, wired into
  `service install|restart|refresh` and `reset`) shipped 2026-08-04; amended 2026-08-06
  (close-out, #725: measurable eval signal `roster.role_query`, roster-first `musterd role`,
  verb-list correction, first warn→deliberate-proceed measurement recorded below —
  docs/superpowers/specs/2026-08-06-adr-227-closeout-design.md)
- **Date:** 2026-08-04
- **Owner:** izzo (design session with nick, 2026-08-04)
- **Supersedes / relates to:** ADR 069/070 (the capability substrate this extends), ADR 112 (steward — the first worked role), ADR 145 (admins are human-only), ADR 150 (structural inducement — the gate pattern increment 2 reuses), ADR 191/219/131 (the liveness trio discovery composes with), ADR 026–030 (provisioning templates — the per-harness rendering half), landscape.md §9 (the AgentField survey that widened the scope)

## Context

The roster answers "who is alive" in fine grain — presence, posture, quiescence (ADR 219),
wakeability (ADR 131) — and "who can do what" not at all. The ADR 069/070 capabilities are
**restrictions** (may this seat send, observe, admin), never **affordances** (is this seat the one
that owns UI). `Member.role` is one free-text string validated against nothing. `team_members`
filters by exact name only. A charter is prose nothing indexes. So the aptitude half of the team
lives in tribal memory: "all frontend is miley's" is a standing owner rule recorded nowhere a tool
can read, and "ask the platform agent" requires already knowing who that is.

The prompting problem (captured 2026-07-13, `docs/design/roles-and-stewardship.md`): any agent can
restart, rebuild, or migrate shared infrastructure while teammates depend on it, and the dogfood
record shows the cost — a `service install` from the wrong shell crashlooped the daemon for
everyone; refreshes drop live sessions. The desired end state is that only designated platform
seats touch running infrastructure and everyone else routes infra asks to them.

The 2026-08-04 AgentField survey (landscape.md §9) sharpened the missing piece: their registry
answers "who can do X, and are they healthy" — the aptitude half plus the liveness half in one
selector. musterd has the liveness half already; this ADR adds the aptitude half and the composition.

The design session (2026-08-04, nick + izzo) settled the forks recorded below. The seed doc remains
the capture of the full ambition — the wishlist library, the guardian-on-call sketch, the eight
questions — and this ADR freezes the subset that builds now.

## Decision

### 1. The role model — extended in number, unchanged in kind

A role stays exactly what ADR 070 built: `roles/<name>.toml` in git — `{ name, capabilities
(partial defaults, narrow-only), charter }` — held by an ordinary seat. **Never a protocol power**
(the no-orchestrator stance holds). Two extensions:

- **Multi-role.** `Member.role` (one free-text string) becomes `roles: string[]`, validated against
  the library; the first entry is the display label. Schema bump with a back-compat read of the old
  field. A seat may be `designer` and `platform` at once — on a team this size, duties overlap.
- **`summary`.** Roles gain a required one-line summary the roster can surface; the full charter
  stays prose for humans and primers.

Two boundaries, confirmed explicitly in the session:

- **Roles are optional.** A seat with no role is the ADR 070 generalist default — exactly today's
  behavior. A role is a duty a seat takes on, not a registration requirement; most seats stay
  roleless and discovery shows an empty column for them.
- **Admin is not a role.** `is_admin` remains a capability, human-only per ADR 145. The ADR 070
  narrow-only clamp already guarantees no `roles/*.toml` can mint an admin — a role can only
  restrict capabilities, never widen them. Authority (admin) and aptitude (role) stay orthogonal;
  humans hold roles from the same library.

### 2. Increment 1 — discovery: the selector, not a new address

`team_members` (tool and CLI) gains a role filter and returns, per seat: roles, role summary, and
the existing liveness trio (presence, quiescence, wakeable). "Quiet + wakeable + holds `platform`"
becomes one filtered query. That is the whole increment: **no new recipient kind on the wire.**
Sends stay seat-addressed; the sender queries the roster, picks a named seat, and sends to it —
identity explicit at every hop.

Role-addressed sends (`to: 'role:platform'`, daemon resolves to one eligible holder) are
**deliberately deferred**, on nick's challenge in the session: if the wire anonymizes recipients,
what are named seats for? The honest answer is that daemon resolution preserves identity in the
audit but is machinery we have no evidence we need. Reopening trigger: dogfood showing senders
repeatedly re-implementing the holder-pick by hand (the Phase-2-lanes pattern — build on evidence
Phase 1 cannot produce).

### 3. Increment 2 — the infra-touch guardrail, warn-only

Infra verbs — `service install|restart|refresh`, `reset`, and `agent` (added post-ship, #689: it
rewrites the machine-shared MCP entry) — get an ADR 150-style pre-execution check. Migrations are
**not** gated, because no `migrate` CLI verb exists to gate; collision safety for migrations is
ADR 245's strictly-upward ladder gate, and gating a migrate verb is deferred until one exists.
The check: if the acting seat does not hold `platform`, print a warning that **names the
current holders from discovery** ("izzo holds platform — route an ask instead of touching this
yourself"), emit an audit event (`infra.touch.warned`, with seat + verb), and **proceed**. Never
blocks. This is the lanes doctrine applied to infrastructure: watcher, never gatekeeper, while the
team's daily work is still the platform itself.

The hardening ramp is documented here and **not** built: warn → require `--force` + audit → refuse.
Each step is evidence-gated (do warns actually redirect behavior? does anyone trip the gate who
shouldn't?) and flipped by an admin via team policy, never by a code change landing silently.

### 4. The v1 library — four live roles, the rest stay templates

| role       | holder   | charter anchor                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform` | izzo     | Designated toucher of running infrastructure: daemon lifecycle, service verbs, shared checkouts, migrations; supervises the ADR 152 auto-refresher. (stanley is the named alternate; assignment is nick's call at review.)                                                                                                                                                                                                                                    |
| `designer` | miley    | Owns the design surfaces (/live, office, CLI output contract, Figma frames); the standing owner rule — frontend is miley's, magical/warm/on-brand — as a charter instead of tribal memory.                                                                                                                                                                                                                                                                    |
| `steward`  | (Action) | Re-anchor the ADR 112 charter (`scripts/steward/CHARTER.md`) as `roles/steward.toml`; the seat-residency migration stays with ADR 131.                                                                                                                                                                                                                                                                                                                        |
| `observer` | (unheld) | Fold the `observer` role already live in MCP scope-by-role (ADR 144 inc 5) into the library, so the library describes reality rather than adding a parallel one. _(Amendment 2026-08-06: wanderer moved to the generalist default; the role stays in the library — a role without a holder is just a file — and ADR 144 inc 5's scope-by-role now has no live exerciser, so re-holding observer is where evidence for that scope narrowing would come from.)_ |

The rest of the seed-doc wishlist (product manager, facilitator/brainstorm, experimenter,
researcher, support, database guru) stays as documented templates, unheld — the library is
open-ended and a role without a holder is just a file.

Assignment is a seat-file edit with a `musterd role assign <seat> <role>` convenience wrapper —
durable-on-git like everything else about a seat (ADR 058), no new ceremony.

### 5. Deferred, each with its reopening trigger

| deferred                        | reopens when                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Role-addressed sends            | dogfood shows senders re-implementing the holder pick (§2)                                                                      |
| Platform guardian on-call agent | its own ADR, as a later increment of the `platform` role; needs the probe design (seed doc, guardian sketch)                    |
| Autonomy tiers as team policy   | needed only once the guardian exists (its `observe`/`alert`/`auto` dial)                                                        |
| Free capability tags on seats   | roles prove too coarse for real discovery queries — at ~8 seats a folksonomy is noise, and the git role file is the trust story |

### What we deliberately do not copy

From the AgentField comparison: no central control plane (routing every call through an enforcer is
the opposite of seats that can decline), no inline blocking enforcement (warn-never-block is
load-bearing), no tag/credential ceremony. The borrow is the _question_ their registry answers, not
their architecture.

## Consequences

- The standing "who owns X" knowledge moves from memory into files a tool reads; new seats learn it
  from the roster instead of from being told.
- The guardrail changes no behavior on day one — it makes the existing norm visible and audited,
  and gives the hardening ramp a place to stand when the platform stabilizes.
- The schema bump (`role` → `roles[]`) touches protocol, daemon, CLI, MCP render, and the seat
  files; it ships with increment 1 behind a back-compat read, so existing seat files stay valid.
- `FEATURE_EPOCH` bumps with increment 1 (client-visible roster capability, per the ADR 148 ritual).

## Observability & Evaluation

**Traces.** Two signals, both on the ADR 071 audit rail. (1) Discovery: each authenticated
role-filtered roster read writes a `roster.role_query` audit row (actor seat,
`detail: {role, holders}`). _Amendment 2026-08-06: this replaces the original "countable parameter
on the tool-stats row" wording — that described a `tool_call_stats` column that never existed, and
a filter the daemon never saw (it ran client-side in the MCP tool). The close-out (#725) moved the
filter server-side (`GET /members?role=`) precisely so this row could exist. Anonymous reads
filter but are not audited — the eval joins actor→send, and an anonymous read has no seat to
join._ (2) The guardrail: each tripped check emits an `infra.touch.warned` audit event (seat,
verb, holders named at the time). Roster truth is self-checking: `roles[]` values are validated
against `roles/*.toml` at load, and an unknown role name is a warn-level roster event, so the
library and the seat files cannot drift silently.

**Eval** — dataset: the audit log over the first two weeks after each increment lands.

- **Increment 1 pass:** `roster.role_query` rows from real (non-test) seats appear within two
  weeks of the close-out landing. Zero means the surface or the primer failed — the design is
  wrong, not the team.
- **Increment 2 pass:** every `infra.touch.warned` event joins (by seat + time) to a following ask
  directed at a `platform` holder, or to a deliberate proceed by a seat doing platform work. A high
  warn count with zero redirects means the warning text or the routing affordance failed — fix
  that, don't block harder. The warn→redirect rate is the evidence the hardening ramp waits for.
- **Reopening trigger, measured:** the deferred role-addressed send reopens when this join fires
  repeatedly — role-filtered discovery followed within 120s by a directed send from the same seat,
  exactly the pair the deferred feature would collapse to one:

  ```sql
  -- role-filtered discovery followed within 120s by a directed send from the same seat
  SELECT a.ts, a.actor, json_extract(a.detail,'$.role') AS role, m.act, tm.name AS sent_to
    FROM audit a
    JOIN members fm ON fm.name = a.actor
    JOIN messages m ON m.from_member = fm.id
     AND m.ts BETWEEN a.ts AND a.ts + 120*1000
     AND m.to_member IS NOT NULL
    LEFT JOIN members tm ON tm.id = m.to_member
   WHERE a.action = 'roster.role_query'
   ORDER BY a.ts;
  ```

**First increment-2 measurement (run 2026-08-06 against the live team DB — every
`infra.touch.warned` row then existing, n=3).** Join window: directed sends from the warned seat
within 30 minutes; classification from the send bodies and the seat's own status updates.

| warned at (UTC)  | seat    | verb      | classification                                                                                            |
| ---------------- | ------- | --------- | --------------------------------------------------------------------------------------------------------- |
| 2026-08-05 19:31 | stanley | `agent`   | deliberate proceed — verifying #689, the change that added `agent` to this very gate                      |
| 2026-08-05 22:48 | ryder   | `refresh` | deliberate proceed — "nick asked me to force it rather than wait for autorefresh" (ryder's status_update) |
| 2026-08-05 22:49 | ryder   | `refresh` | deliberate proceed — second bounce of the same human-directed refresh                                     |

Warn→redirect rate: **0/3 redirects, 3/3 deliberate proceeds** — the inc-2 pass criterion holds
(every warn joins to a sanctioned proceed), and no warn has yet fired on work that _needed_
redirecting. That is zero evidence for hardening: the ramp stays at warn until a warn is observed
redirecting real unsanctioned work (or failing to). n=3, and one of the three is self-referential
(a warn emitted while testing the gate) — the next measurement should re-run this join before
reading anything into rates.

**Experiment.** None pre-registered for increment 1 (a roster query needs no A/B). The hardening
ramp is the standing experiment for increment 2: each step (warn → `--force` → refuse) is a
policy flip an admin makes only after the eval above shows the current step redirecting behavior —
the ADR 152 `--mode idle|notice` knob precedent, generalized.
