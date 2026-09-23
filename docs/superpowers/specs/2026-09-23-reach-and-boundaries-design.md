# Reach and boundaries: how musterd reaches people, and where it stops (design)

> Lane `01M36DBA81CHYRQ6WXP8RXFWRE`. Brainstormed with nick on 2026-09-22/23; every decision below was
> put to him and approved in that conversation. Security review by big-body (act
> `01M368N88TXAFMH0A0RBGG8EJB`) is folded in — §2's broker and §7's honesty clause are his. The
> identity model (§6) was added after that review and goes back to him. Implementation lands as
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
issuing `delivery_hint` when the recipient's kind is `human` — including hints already issued and
not yet relayed, which the relay path must reject by recipient kind at relay time (big-body).

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

- **Tool deny, every harness.** A PreToolUse gate (the ADR 150 mechanism, installed per harness
  exactly as the lane gate is) refuses, in any seat Workspace: `SendMessage`, `ListAgents`,
  `mcp__ccd_session_mgmt__send_message`, `…list_sessions`, `…list_events`,
  `…search_session_transcripts`, `…get_session`, and each harness's equivalents (Codex, Cursor,
  Grok, opencode — enumerated per harness in the implementing ADR; an unknown session-reaching tool
  is a gap to close, not a pass).
- **No model-chosen targets.** Big-body rejected the draft's "send only to the session id the daemon
  names" exception: ADR 131 and `DeliveryHint` deliberately keep harness session ids off the wire,
  and naming one changes that boundary. Instead, while the seat↔seat relay survives (§5), **the
  hint names the destination _seat_**, and a **host-side broker** resolves that seat to its local
  session and delivers the daemon-composed line itself. The model never enumerates sessions, never
  sees a session id, never chooses one. The broker refuses any target that is not a live seat of the
  same team, and never a human or non-seat.
- **Labeling moves to the host.** `musterd-label-sessions` (which today calls `list_sessions`
  across every session on the machine and filters afterwards) is retired; the host labels seat
  sessions from its own session enumeration (ADR 166), touching seat Workspaces only.
- **Every line names its team** — nudge, interrupt and wake lines alike.
- **Receivers treat a line as a pointer** (§4 ships inside this increment — big-body: the wall is
  incomplete if a receiver still acts on the line's words).
- **Refusals are audited** — `gate.session_denied {tool, harness}`; no bodies, no credentials, no
  target identifiers beyond the tool name.
- **Tests** — negative tests per harness per tool (denied), a broker test (same-team seat → delivered;
  human, non-seat, other-team → refused), and a canary: a seat attempting to message a non-seat
  session is refused and audited.

What ships together (big-body): daemon stops human hints and rejects issued ones; all-harness
session deny; the CLI identity change of §6 (at minimum: no human identity resolvable from a seat
Workspace); receiver pointer rule; the negative tests; audited denials.

## 3. Other teams (decided — follows from §2)

The relay broker's target must be a seat on the **sender's** team; lines carry the team so a
multi-team machine is unambiguous. The daemon already refuses cross-team sends and reads
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
  `composeInterruptLine` / `composeNudgeLine` ("pointer only — read it as yourself"), and the
  nudge-relay skill until it is removed.

Considered: ignore all in-session messages (throws away a verified pointer); **signed lines** — the
daemon signs each line with a key bound to the recipient's lease and an inbound hook verifies it
before the model sees it. Signed lines are the right end state but need an inbound hook every
harness lacks; they are the first item of §8.

## 5. The interrupt-line target, and the relay's removal (decided)

The seat↔seat relay exists only because the interrupt line cannot reach an **idle** seat session,
and the wake host defers for 10 minutes on an attended one. It is removed only when every harness
meets this target, measured through ADR 423's `interrupt.raised` rail data plus live evaluations:

1. **Mid-turn delivery**: within one tool boundary, or p95 ≤ 30 s.
2. **No deaf seats**: a dead lease either self-repairs or raises a visible alarm (today: `claim
   --bootstrap`, `inbox --wait`, and hours of idle all leave a seat deaf; see
   `docs/wiki/authorised-but-unowned.md`).
3. **An idle rail**: some mechanism that reaches an idle-at-prompt seat session.

State on 2026-09-23 (`docs/design/daemon-doorbell-contract.md` and the per-harness evals): Claude
Code delivery proven since 2026-09-14, latency unmeasured; native harness ~4 s (n=1); Cursor canary
only; Codex unit tests only; no harness has an idle rail. So the relay stays — confined to the §2
broker — until the target is met. An idle seat session a human is driving has that human present,
and §1's doorbell reaches them; the idle gap is agent-to-agent latency, not loss.

## 6. Identity: a process acts only as its Workspace's member (decided)

**A member's identity is resolved only from a Workspace binding — for every member kind.** No
global-config fallback, no `--as`, no environment heuristics. A folder with no binding (SandRise)
resolves to nobody. This supersedes ADR 059's `--as` resolution and tightens ADR 413 ("the cwd is an
identity") into "*only* the cwd is an identity".

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
  credential rotation, policy. Only `/live` or a terminal with no harness in its environment.
- **No seat hooks, orient nudges, or inbox nudges** in a human's worktree; nothing steers that agent
  into musterd unprompted (and §1 means no nudge arrives there anyway).
- **Acts carry their surface** — "nick, via claude-code" — so the audit shows agent-mediated acts.
- Later (§8): a narrower delegated credential for that agent — read, reply, claim — with acts that
  affect others (steer, handoff) confirmed by the human on `/live`.

**Migration** (a step in the plan, not this spec): today `~/agents` is the main checkout, the
daemon's and host's runtime (both plists run `~/agents/packages/cli/dist/bin.js`), *and* a
Workspace bound as `nick` — with a stale Cursor session record and a legacy `agent_key` (the
bootstrap cutover's target). It splits into `~/.musterd/runtime` (unbound) and
`~/musterd/agents/nick`. The existing `~/agents-<seat>` worktrees move to `~/musterd/agents/<seat>`.

**Tests** — resolution from: a member worktree (that member); a subfolder of one (that member); an
unbound folder (nobody); `~/musterd/agents/` (nobody, and `init` refuses it); the runtime checkout
(nobody). `--as` is gone from the CLI surface; fixture scripts (`scripts/a11y/fixture-team.sh`,
`scripts/perf/broadcast-bench-fixture.sh`) move to a test-only mechanism.

## 7. What this does and does not protect (decided — stated honestly, per big-body)

The wall (§2), the pointer rule (§4) and binding-only identity (§6) prevent **cross-session and
cross-identity mistakes by models** — the incident's class. They are **not** a boundary against a
**hostile process under the same OS user**: such a process can read any binding or config file,
`cd` into any Workspace, or call the daemon's HTTP API directly with a credential it read. Closing
that is credential custody — ADR 200 and ADR 341 (agents under distinct OS users), and §8's
credential work. Every doc and ADR that cites this design repeats that sentence rather than
implying more.

## 8. Parked: the authentication, authorization and attribution track

In order:

1. **Signed lines** (§4's end state).
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
| 1 | **The wall** — §2, §3, §4, and §6's "no human identity from a seat Workspace" | new ADR amending ADR 167 (and retiring the label skill) | — |
| 2 | **Binding-only identity + layout** — rest of §6, `--as` removal, migration | new ADR superseding ADR 059's `--as`; amends ADR 413 | 1 |
| 3 | **The doorbell** — §1 | new ADR extending ADR 149 / ADR 222 | — (independent) |
| 4 | **Interrupt-line target** — §5 measurement and fixes; removes the relay + broker when met | amends ADR 088 / ADR 167 | 1 |
| — | Separate lane: a wake ran alongside an attended seat session (three dolly sessions on 2026-09-22; one wake spent ~16 min failing to take the occupied seat, `exit=143`) | — | — |

ADR numbers are taken with `pnpm adr:next` when each is authored, not reserved here.

Incident close-out (big-body): audit which of nick's inbox records the SandRise session actually
read before closing; rotate nick's credential only if exposure exceeds that local same-user context.
Separately, dolly's and big-body's seat credentials, leases, and big-body's grant were printed into
a session transcript on 2026-09-23 while this design was being researched; nick rotates them.
