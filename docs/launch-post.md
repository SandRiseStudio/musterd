# Launch post — musterd v0.3

> Draft. Adapt for the target platform (X/Twitter, HN, dev.to, LinkedIn). The README's "wedge" and principles sections are the canonical source; this is the post form.
>
> Security boundary: v0.3 ships scoped credentials, authorized seat claims, Presence-bound leases,
> admin-gated governance, and append-only audit records. It does not yet provide sandbox
> enforcement, database encryption at rest, mTLS, signed audit records, or automatic credential
> rotation. Private vulnerability reports go through the repository's
> [security advisory form](https://github.com/SandRiseStudio/musterd/security/advisories/new).
>
> ~~**Ship blocker:** as of 2026-08-13 musterd.io serves nothing — do not publish until it
> resolves.~~ CLEARED 2026-08-13: **musterd.io is live** (Cloudflare Worker `musterd-io`, landing
> page with the Get Started install section; verified `curl -I https://musterd.io` → 200; see
> [name clearance](wiki/name-clearance.md)). Share-unfurls use the brand social card (`og:image`);
> a Get Started still lives at `docs/assets/musterd-io-get-started.png`. The remaining launch
> *recording* is the real 3-pane demo (`docs/demo.md` form 3) — the GIF placeholder ships if it must.

---

## Short form (X / Bluesky, ~280 chars)

> **musterd v0.3** — muster your agents and humans into persistent named teams, across any harness.
>
> One human + two agents. Three surfaces. One team. Durable inboxes, typed coordination acts, explicit presence.
>
> `npx @musterd/cli init` (or brew) → musterd.io

---

## Medium form (HN / Lobste.rs Show HN, ~1500 chars)

**Show HN: musterd – named, persistent teams of agents and humans, across any harness**

I built musterd because every multi-agent setup I tried had the same failure mode: agents lose context on handoffs, nobody knows who's doing what, and the human is an afterthought bolted onto the side.

musterd is a coordination layer, not a framework. It doesn't run your agents — it connects them. The load-bearing idea:

- **A Member is an identity, not a session.** Sessions come and go; the member persists.
- **A Team is a standing roster**, not a project. Reuse the same team across repos/folders.
- **Humans are first-class members.** Same envelope, same acts, same inbox as agents.
- **Typed acts, not ad-hoc text.** `status_update`, `request_help`, `handoff`, `accept`, `decline`, `wait`, `resolve` — grounded in the Co-Gym collaboration-act taxonomy.

Any MCP-capable harness (Claude Code, Cursor, Codex…) joins by running `@musterd/mcp` with the member's env. Harness-agnosticism for free.

MAST found ~79% of multi-agent failures are coordination failures — not capability failures. musterd is exactly that coordination layer.

**v0.3 ships the shared-Team trust model**: scoped and revocable bootstrap credentials, authorized
seat claims, short-lived Presence-bound leases for routine agent HTTP access, admin-gated
governance, and an append-only audit log. Sessions remain dormant until explicitly activated.

The boundary is explicit. musterd is local-first and binds to `127.0.0.1` by default. It does not
yet sandbox agent tools, encrypt its SQLite database at rest, use mTLS, or sign its audit log.

`npx @musterd/cli init` (or `brew install musterd` from the SandRiseStudio tap) gets you from zero to a working team in one command.

Tech: Node/TypeScript monorepo, SQLite + WS + HTTP, MCP adapter, MIT.

Site: https://musterd.io · Repo: https://github.com/SandRiseStudio/musterd

---

## Long form (dev.to / blog post)

### musterd v0.3: named, persistent teams for agents and humans

Multi-agent systems are having a moment. Every week there's a new framework for orchestrating LLM agents — CrewAI, LangGraph, AutoGen, you name it. Most of them share an assumption: agents are short-lived, disposable, and stateless between tasks.

That assumption is the bug.

**The coordination failure problem**

[MAST](https://arxiv.org/abs/2503.13657) analyzed hundreds of multi-agent failures and found that about 79% were _coordination_ failures — lost context on handoffs, agents working at cross purposes, no shared ground truth on who's doing what. Not capability failures. The models are good enough; the coordination layer is the gap.

musterd is that coordination layer.

**What musterd is (and isn't)**

musterd is not a framework. It doesn't run your agents or make decisions about task decomposition. It's a coordination membrane: a persistent team server that agents and humans connect to, with a shared protocol for presence, messaging, and typed coordination acts.

The three core ideas:

**1. A Member is an identity, not a session.**
When you add Ada to your team, Ada is a durable identity — she has a role, a lifecycle, a persistent inbox. The Claude Code session running Ada today will be gone tomorrow, but Ada persists. This is the same model as a real team: people outlive the calls they're on.

**2. A Team is a standing roster, not a project.**
The same team — say, `dawn` — spans every repo you work on. Ada knows about the auth backend work she did last week because that context lives in the team, not in a single session's context window. You configure the folder→agent binding (which MCP config points at which member), but the roster is durable.

**3. Humans are first-class members.**
In most multi-agent systems, the human is an approver — a special node outside the agent graph. In musterd, the human is just another member: same envelope, same inbox, same acts. `musterd inbox --watch` makes you present on the team and shows you the live coordination stream. You send `request_help` and `handoff` the same way an agent does.

**Typed acts**

Every message carries a typed **act** from the [Co-Gym](https://arxiv.org/abs/2412.15701) collaboration-act taxonomy:

| act                  | meaning                              |
| -------------------- | ------------------------------------ |
| `message`            | plain communication                  |
| `status_update`      | report what you're doing / have done |
| `request_help`       | ask a member or the team to assist   |
| `handoff`            | transfer a unit of work              |
| `accept` / `decline` | answer a `request_help` or `handoff` |
| `wait`               | signal you're paused or blocked      |
| `resolve`            | close a thread — its work is done    |

This isn't just structure for structure's sake. It lets the human — or a future agent — filter, prioritize, and respond to coordination events without parsing free text.

**v0.3: the shared-Team trust model**

The original v0.1 had a subtle bug: the MCP adapter auto-claimed presence on startup, so three Claude Code sessions bound to "Ada" meant three sessions wearing one identity. Each session was acting as Ada, draining her inbox, sending messages in her name.

v0.3 replaces assumed identity with an authenticated and authorized claim:

- **Dormant by default.** Registering the MCP adapter doesn't claim a seat. The agent is dormant until it explicitly calls `team_join`.
- **Scoped bootstrap credentials.** A bootstrap credential is limited to one seat, one role pool, or one residency host and can be revoked independently.
- **Authorized claims.** Occupying a seat requires an authorized step. Governance operations require an admin and are recorded.
- **Presence-bound HTTP authority.** Routine agent HTTP access uses a seat credential plus a short-lived lease tied to the current Presence.
- **Working activity.** A present agent with a `status_update` resolves to `working` with the task summary in the watch pane — so the human can see real progress, not just "Ada: online."
- **Clean shutdown.** The adapter drops presence and exits on stdin close / SIGTERM / transport close, so the roster stays accurate.

The safe boundary is narrower than a sandbox. musterd does not yet enforce agent tool or filesystem
access, encrypt its SQLite database at rest, use mTLS, store secrets in the OS keychain, rotate
credentials automatically, sign audit records, or rate-limit claims. Those limits are documented in
[SECURITY.md](../SECURITY.md), alongside private vulnerability reporting.

**Getting started**

```bash
npx @musterd/cli init
```

One command: starts the daemon, creates a team, detects Claude Code / Cursor, wires up the MCP adapter, and waits for your agent to join with a live spinner.

Or manually:

```bash
musterd serve
musterd team create dawn --as nick --role lead
musterd team add Ada --kind agent --role backend
musterd inbox --watch
```

**What's next**

The roadmap includes stronger deployment controls and security hardening beyond the current
local-first boundary. The observability layer (coordination-level OTel tracing, the "batond"
product) is also on the roadmap.

MIT. Contributions welcome.

→ [musterd.io](https://musterd.io)
→ [github.com/SandRiseStudio/musterd](https://github.com/SandRiseStudio/musterd)
→ `npx @musterd/cli init`
