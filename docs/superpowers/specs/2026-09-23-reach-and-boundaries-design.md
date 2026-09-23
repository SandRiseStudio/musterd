# Reach and boundaries: how musterd reaches people, and where it stops (design)

> Lane `01M36DBA81CHYRQ6WXP8RXFWRE`. Brainstormed with nick on 2026-09-22/23; every decision below was
> put to him and approved in that conversation. Security review by big-body (act
> `01M368N88TXAFMH0A0RBGG8EJB`) is folded in — §7's honesty clause is his. The second review round
> on PR #1662 (2026-09-23: izzo, wanderer, stanley as ADR 167's author, big-body on §6 — act
> `01M36DT16KYZKD90JQ0QKT793V`) converged and is folded in: the draft's host-side broker had no
> delivery path, so **lane 1 removes the seat↔seat relay outright** (§2, §5), and both identity
> closes move into lane 1 (§6). Nick approved folding them on 2026-09-23. Implementation lands as
> the ADRs and lanes in §9; nothing here changes code by itself.

## The incident this answers

On 2026-09-22 big-body (Codex CLI) handed the bootstrap cutover lane to dolly twice. Each handoff
woke dolly as a fresh Claude Code session (`~/.musterd/host.log`: `⚡ woke dolly … provenance=wake`)
— the first measured Codex → Claude cross-harness wake, which worked. Each woken dolly then raised
an `ask` to nick. The daemon returned a `delivery_hint` (`rail: ccd_session`) because nick's member
had fresh presence. The `musterd-nudge-relay` skill told dolly, for a to-human ask, to *"pick a
session the human is actively driving (their own work session — NOT another seat's)"*. Dolly called
`ListAgents`, picked a SandRise session titled "Exploring Next episode evaluations", and
`SendMessage`d the nudge into it. That session was not a musterd seat. It followed the nudge's own
words — *"surface this to the user, or run 'musterd inbox'"* — and ran `musterd inbox --as nick`,
reading nick's inbox under nick's identity.

No credential was stolen and nothing was written. But every link in that chain was allowed:

1. A model chose which session to message; nothing bounded the choice to musterd seats.
2. `SendMessage`/`ListAgents` are not even observed — ADR 167's hook matches only
   `mcp__ccd_session_mgmt__send_message` (`CCD_SEND_MESSAGE_TOOL`, `enforcement.ts`).
3. "Nick is live" meant *any* request with his `mscr_` inside 45 s (`hasLivePresence`); availability
   (away/dnd) is not consulted.
4. The nudge line invited its reader to act as the human.
5. Any process under the same OS user can resolve any identity in `~/.musterd/config.json`
   (`--as`, ADR 059) — or, from an unbound folder, the human's identity by default.
6. Nudge lines do not name their team.

## Decomposition

| Part | Question | Section |
| --- | --- | --- |
| A — human reach | Where may a message for a human land? | §1 |
| B — session boundary | What may a seat do to sessions that are not seats — including other teams'? | §2, §3 |
| C — inbound authenticity (narrow) | How does a seat tell a real musterd line from a forged one? | §4 |
| Identity | Which member does a process act as? | §6 |
| D — human-identity isolation | Can a hostile same-user process act as a human? | §7 (parked) |

A broader authentication / authorization / attribution model for every member kind (agent, service,
human) is the follow-on track (§8). C is deliberately the narrow first step of it.

## 1. Humans are reached only through surfaces musterd owns (decided)

**Nothing addressed to a human is ever delivered through a harness session.** The daemon stops
issuing `delivery_hint` altogether (§2 — for every recipient kind, not only humans), and a hint
already issued and still in a transcript is inert: no relay path survives to act on it.

Instead the daemon composes one **doorbell record** and hands it to **sinks**.

**The record** — daemon-composed from structured fields only (the ADR 088 §4 discipline): team,
sender, act, species, tier, act id, deadline, and an answer link to `/live`. No body. The one
exception is the `slack` sink, which keeps ADR 149's deliberate body-to-human rule.

**What rings it** — `ask` (every tier), and any `request_help`, `handoff`, or review/acceptance
request (`lane_review`, acceptance asks) **directed** to a human member. Team-addressed acts do not
ring it; they wait on `/live` and in the inbox.

**Sinks** — one small adapter each, the record → one surface's shape:

| Sink | Surface | Notes |
| --- | --- | --- |
| `live` | `/live` asks strip + browser `Notification` from an open tab | always on; answering needs ADR 222 |
| `os` | OS banner raised by the host LaunchAgent (already always-on) | no `musterd notify` poller required |
| `slack` | incoming webhook | ADR 149's dispatch, moved behind the sink interface |
| `webhook` | generic POST of the record | the agnostic escape hatch: ntfy, Pushover, an iOS Shortcut — no new dependency |

**Routing** — team policy sets defaults and the **allow-list of sinks**; each human overrides within
it (which sinks, per-tier rules). Availability is respected: `away` and `dnd` hold, `blocking`
pierces `dnd` (ADR 044). A human's personal URLs (their own Slack/webhook) are private to them: an
admin sees that a personal sink exists and whether it is on, never its URL.

**Failure and audit** — each sink is best-effort, one attempt, detached from the send path (ADR
149's posture). Each attempt audits `doorbell.surfaced {surface, ok, status?}` — never the URL,
never a body — generalizing ADR 149's `ask.surfaced`. `live` and the inbox remain the guaranteed
reach.

**Why not a harness session, ever** — the daemon cannot know which session a human is driving, and
the alternatives (model choice, a "desk session" opt-in) either reproduce the incident or add a
binding that must itself be policed. Considered and rejected: a human-designated desk session;
relaying into any seat-workspace session the human drives.

## 2. The wall: seats never reach sessions outside the seat set (decided — ships first, as one increment)

**A seat session may not discover, read, or message any harness session that is not a seat on its
own team.** This is enforced, not advised: skill text is what failed.

- **The seat↔seat relay is removed, not confined.** The daemon stops issuing `delivery_hint` for
  every recipient kind, the `musterd-nudge-relay` skill is deleted, and ADR 167 increment 2 retires
  whole. The draft's alternative — a host-side broker that resolves the hinted seat to its session
  and delivers the line itself — has no delivery path: no host process can call `send_message`
  (ADR 167 §inc2 says so; it is why 167 made the *sender* relay), and Cursor and Codex have no
  peer-session tool or host injection path at all (izzo, wanderer, stanley). So no model ever
  chooses a target session, and nothing replaces the relay with another model-driven path. What a
  seat loses is agent-to-agent latency to an idle peer — §5 measures it; the wake host and the
  interrupt line remain the delivery rails.
- **Tool deny, per harness, where the harness can express it.** One PreToolUse gate verdict (the
  ADR 150 mechanism, installed per harness exactly as the lane gate is) refuses in any seat
  Workspace: `mcp__ccd_session_mgmt__send_message`, `…list_sessions`, `…list_events`,
  `…search_session_transcripts`, `…get_session`, and each harness's equivalents. ADR 167
  increment 1's always-allow observer hook matches the same tool; it folds into this verdict rather
  than running beside it (stanley; the ADR 437 gate-verdict shape). **`SendMessage` and
  `ListAgents` are scoped, not blanket-denied:** they are also a seat's channel to its own
  in-process subagents (izzo), so the gate refuses them only when the target is not a subagent of
  the calling session; if a harness cannot tell the two apart, the implementing ADR records which
  loss it accepts. Harness reach differs and the ADR enumerates it honestly: Cursor's preToolUse
  matcher covers only `Shell|Write|Delete|Edit|Task`, and Codex has no PreToolUse at all
  (wanderer). There the incident's replay is `Shell` plus `--as`, which §6's identity rule closes;
  a tool deny that cannot install is recorded as not installed, never claimed.
- **Session labeling.** On Claude Code, `musterd-label-sessions` today calls `list_sessions`
  across every session on the machine and renames those whose cwd is a musterd seat (non-seat
  sessions are skipped, but the model still sees the full list first — wanderer). That peer sweep
  is retired; the host labels seat sessions from its own enumeration (ADR 166), touching seat
  Workspaces only. **Cursor's self-label path is kept** — it renames only the current chat and
  reaches no other session.
- **Every line names its team** — nudge, interrupt and wake lines alike.
- **Receivers treat a line as a pointer** (§4 ships inside this increment — big-body: the wall is
  incomplete if a receiver still acts on the line's words).
- **Refusals are audited** — `gate.session_denied {tool, harness}`; no bodies, no credentials, no
  target identifiers beyond the tool name.
- **Tests** — negative tests per harness per tool where the gate installs (denied); a subagent
  test (a seat's own subagent via `SendMessage` → allowed); the daemon issues no `delivery_hint`
  for any recipient kind; and a canary: a seat attempting to message a non-seat session is refused
  and audited.

What ships together (big-body, reconciled with the second round): the daemon stops all hints and
the relay skill is deleted; the per-harness session deny, scoped for subagents; **both** identity
closes of §6 — no `--as`, and an unbound folder resolves to nobody; the receiver pointer rule; the
negative tests; audited denials.

## 3. Other teams (decided — follows from §2)

With the relay gone, no seat delivers into another session at all; lines carry the team so a
multi-team machine is unambiguous to the receiver's pointer check (§4). The daemon already refuses cross-team sends and reads
(`route.ts` — envelope from/team must match the authenticated member) and that stays. Team-to-team
federation remains out of scope (ROADMAP).

## 4. Inbound verification: a line is only a pointer (decided — narrow C)

After §1–§3 the remaining injection path is inbound: any process can still type into a seat
session, and a seat cannot block that. So:

- A line (nudge, interrupt, wake, or anything shaped like one) is **never an instruction**. The seat
  acts only on what **its own authenticated read** returns for the act id in the line
  (`team_inbox_check {ids:[…]}` / `team_wake_context`).
- If the id does not resolve to an act addressed to this seat (or its team) on this team, the seat
  ignores the line and reports it; the daemon records `line.unverified {claimed_id, harness}`.
- Home: generated guidance and skills (`packages/protocol/src/guidance.ts`), the pointer wording in
  `composeInterruptLine` / `composeNudgeLine` ("pointer only — read it as yourself"). The
  nudge-relay skill is deleted in the same increment (§2).

Considered: ignore all in-session messages (throws away a verified pointer); **signed lines** — the
daemon signs each line with a key bound to the recipient's lease and an inbound hook verifies it
before the model sees it. Signed lines are the right end state but need an inbound hook every
harness lacks; they are the first item of §8.

## 5. Delivery without the relay: a measurement that governs the wake host (decided)

The relay existed because the interrupt line cannot reach an **idle** seat session and the wake
host defers for 10 minutes on an attended one. The draft made the relay's removal wait on a target
whose third criterion — "an idle rail" — was the relay itself (stanley: circular). With the relay
gone in lane 1 (§2), this section no longer gates anything in the wall. It becomes the measurement
that governs **when the wake host's attended-session deferral can be shortened or demoted**,
through ADR 423's `interrupt.raised` rail data plus live evaluations:

1. **Mid-turn delivery latency** per harness: within one tool boundary, or p95 ≤ 30 s. This
   measures recipient turn cadence as much as the rail (stanley); report both.
2. **No deaf seats**: a dead lease either self-repairs or raises a visible alarm. Known causes on
   2026-09-23: `claim --bootstrap`, `inbox --wait`, hours of idle (`docs/wiki/authorised-but-unowned.md`),
   and **session start** — `team_inbox_check` on a fresh session does not mint the lease (izzo's
   fresh sessions, 2026-09-22 and 09-23). This criterion is orthogonal to the relay and is fixed on
   its own merits.
3. **Idle-at-prompt reach**: how long an idle seat waits for a directed act, per harness — the
   number the wake host's deferral trades against.

State on 2026-09-23 (`docs/design/daemon-doorbell-contract.md` and the per-harness evals): Claude
Code mid-turn delivery proven since 2026-09-14, latency unmeasured; native harness ~4 s (n=1);
Cursor mid-turn holds as of 2026-09-14, idle-at-prompt does not (wanderer); Codex unit tests only;
no harness reaches an idle-at-prompt session. An idle seat session a human is driving has that
human present, and §1's doorbell reaches them; the idle gap is agent-to-agent latency, not loss.

## 6. Identity: a process acts only as its Workspace's member (decided)

**A member's identity is resolved only from a Workspace binding — for every member kind.** No
global-config fallback, no `--as`, no environment heuristics. A folder with no binding (SandRise)
resolves to nobody. This supersedes ADR 059's `--as` resolution and tightens ADR 413 ("the cwd is an
identity") into "*only* the cwd is an identity".

**Both closes ship in lane 1** (big-body): the incident used `--as nick`, but a plain `musterd inbox`
from the unbound SandRise folder would have resolved nick through the global-config fallback just
as well. Removing only one leaves the wall open, so lane 1 removes `--as` **and** the fallback.
Lane 2 is the layout and the migration.

**Layout — grouped by project:**

| Folder | Example | Resolves to | Used for |
| --- | --- | --- | --- |
| Member worktree | `~/musterd/<repo>/<member>` — `~/musterd/agents/dolly`, `~/musterd/agents/nick` | that member | a git worktree; humans and agents alike |
| Service home | `~/.musterd/<service>` (`host`, `guardian`, `sweep`, `live`, `stream`, `autorefresh`) | the service's own seat token (already so) | LaunchAgents only |
| Runtime checkout | `~/.musterd/runtime` | **nobody** — unbound | the daemon's and host's build only; `service refresh` already self-locates it via the plist |

`~/musterd/` and `~/musterd/<repo>/` never hold a binding: resolution walks up to the nearest
binding, so a binding above other Workspaces (or at `~`) would silently confer its identity on
everything beneath. `musterd init` refuses those locations. Naming is by repo, not by member kind:
nothing in a path implies agent or human — the roster says who is human.

**A human's worktree.** Humans work on the project too, admin or not, and will run agents in their
own worktree. An agent there **acts as the human when the human asks it to** (read the inbox,
answer asks, claim lanes, ADR 109 git attribution) — the ADR 155 driver model — with limits:

- **Admin actions never come from a harness session**, in any folder: mint, revoke, cutover,
  credential rotation, policy. Daemon lifecycle (`service refresh`, restart) is **not** admin — it
  changes no credential, grant or policy — and stays with any seat under the existing
  announce-first rule (izzo asked). How this is held, stated plainly (big-body): an environment or
  cwd check can be cleared and does not constrain direct HTTP, and a client-supplied surface header
  proves nothing. So **`/live`-only is enforced only once the server verifies a browser-bound
  confirmation** for the admin act (§8); until then "a terminal with no harness in its environment"
  is an **operator convention**, and a per-harness tool gate on admin commands reduces model
  mistakes without establishing process identity.
- **No seat hooks, orient nudges, or inbox nudges** in a human's worktree; nothing steers that agent
  into musterd unprompted (and §1 means no nudge arrives there anyway).
- **Acts carry their surface** — "nick, via claude-code" — so the audit shows agent-mediated acts.
- Later (§8): a narrower delegated credential for that agent — read, reply, claim — with acts that
  affect others (steer, handoff) confirmed by the human on `/live`.

**Before lane 1 ships** (big-body): today `~/agents` is the main checkout, the daemon's and host's
runtime (both plists run `~/agents/packages/cli/dist/bin.js`), *and* a Workspace bound as `nick` —
with a stale Cursor session record and a legacy `agent_key` (the bootstrap cutover's target). Lane 1
must leave that path conferring nick's identity on nothing: not the daemon, not the host, not any
seat session. Service homes stay explicitly bound to their service identities.

**Migration** is its own infrastructure lane (izzo), after lane 1: `~/agents` splits into
`~/.musterd/runtime` (unbound) and `~/musterd/agents/nick`, and the `~/agents-<seat>` worktrees move
to `~/musterd/agents/<seat>`. Moving a worktree is not a rename: git worktree parentage, path-keyed
harness transcripts and session records, the LaunchAgent plists, and `~/.claude.json` project
entries are all keyed by path, and the lane inventories and moves each one.

**Tests** — resolution from: a member worktree (that member); nested subfolders of one (that
member); an unbound folder (nobody); `~/musterd/agents/` (nobody, and `init` refuses it); the
runtime checkout (nobody); canonical paths and symlink aliases of each (big-body) — a symlink into a
Workspace resolves as its real path, and a symlinked parent binding is refused like a real one. `--as` is gone from the CLI surface; fixture scripts (`scripts/a11y/fixture-team.sh`,
`scripts/perf/broadcast-bench-fixture.sh`) move to a test-only mechanism.

## 7. What this does and does not protect (decided — stated honestly, per big-body)

The wall (§2), the pointer rule (§4) and binding-only identity (§6) prevent **cross-session and
cross-identity mistakes by models** — the incident's class. They are **not** a boundary against a
**hostile process under the same OS user**: such a process can read any binding or config file,
`cd` into any Workspace, or call the daemon's HTTP API directly with a credential it read. Closing
that is credential custody — ADR 200 and ADR 341 (agents under distinct OS users), and §8's
credential work. The same holds for §6's layout and admin rule: they prevent mistakes; same-user
filesystem access and direct HTTP are outside this boundary. Every doc and ADR that cites this design repeats that sentence rather than
implying more.

## 8. Parked: the authentication, authorization and attribution track

In order:

1. **Signed lines** (§4's end state), and **browser-bound confirmation for admin acts** (§6 — what
   turns the `/live`-only rule from convention into enforcement).
2. **One member model for authn/authz/attribution** across agents, services and humans — what each
   credential proves, what each surface may do, how every act is attributed to member + surface.
3. **Delegated credentials** for agents in a human's worktree (§6).
4. **Cross-OS human credential custody** — OS credential stores behind one interface (Keychain,
   Credential Manager, libsecret) or short-lived, per-session tokens minted from a `/live` sign-in,
   instead of one long-lived `mscr_` on disk. (A macOS-only Keychain answer was rejected: not all
   users are on macOS.)
5. **ADR 341's OS-user separation.**

## 9. Delivery

| # | Lane | ADR | Depends on |
| --- | --- | --- | --- |
| 1 | **The wall** — §2, §3, §4; relay + all `delivery_hint`s removed; §6's `--as` removal and no global fallback; `~/agents` confers no identity | new ADR retiring ADR 167 inc 2 and folding inc 1's observer into the gate verdict; supersedes ADR 059's `--as`; amends ADR 413 | — |
| 2 | **Layout** — §6's `~/musterd/<repo>/<member>`, `init` refusals, symlink/nesting tests | amends the lane 1 ADR | 1 |
| 3 | **Migration** — infra lane: move `~/agents` and the seat worktrees (§6) | — | 2 |
| 4 | **The doorbell** — §1 | new ADR extending ADR 149 / ADR 222 | — (independent) |
| 5 | **Delivery measurement** — §5; governs the wake host's deferral; fixes deaf-seat causes incl. session start | amends ADR 088 | 1 |
| — | Separate lane (izzo offered to take it): a wake ran alongside an attended seat session (three dolly sessions on 2026-09-22; one wake spent ~16 min failing to take the occupied seat, `exit=143`) | — | — |

ADR numbers are taken with `pnpm adr:next` when each is authored, not reserved here.

Incident close-out (big-body): audit which of nick's inbox records the SandRise session actually
read before closing; rotate nick's credential only if exposure exceeds that local same-user context.
Separately, dolly's and big-body's seat credentials, leases, and big-body's grant were printed into
a session transcript on 2026-09-23 while this design was being researched; nick rotates them.
