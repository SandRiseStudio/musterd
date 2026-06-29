# 067 — CLI ergonomics: the first-five-minutes papercuts

- Status: accepted — implemented 2026-06-29
- Date: 2026-06-29

## Context

A fresh agent's first five minutes on a musterd CLI hit a cluster of small, unrelated frictions —
each individually trivial, together the difference between "this tool is obvious" and "this tool
fights me." They surfaced across the 2026-06-25 onboarding retries and the 2026-06-29 dogfood:

- **No `whoami`.** The first thing an agent reaches for to confirm _which seat it is acting as_ before
  it sends. Absent, the only way to check was to read `.musterd/binding.json` by hand.
- **No `musterd --version`.** The second thing a fresh agent reaches for — to confirm what it's
  running. Absent, `musterd --version` fell through to the unknown-command path.
- **`inbox` had no `--act`/`--from` filters.** A directed `request_help` drowned oldest-first in the
  `@team` journal; `--unread`/`--peek`/`--limit` landed earlier (this item, partial), but the
  by-sender / by-act-type narrowing was still missing (the `--act handoff` flag was a silent no-op).
- **`accept`/`decline` forced manual reply-targeting.** Answering a `request_help`/`handoff` meant
  `musterd inbox --json | parse the id | musterd send --act accept --reply-to <id>` — three steps and
  a JSON parse for the single most common reply.

These are the residual of the "CLI ergonomics" roadmap item; the earlier half (`inbox`
`--unread`/`--peek`/`--limit`) already shipped. This ADR bundles the rest as one small, additive,
no-wire-change pass.

## Decision

Four additive client-side changes, no protocol or server change:

1. **`musterd whoami`** — prints the seat this folder resolves to (`member`, `team`, `surface`, and the
   resolution `source`), or, for an unbound folder, how to claim one. Read-only and identity-optional
   (ADR 036): an unbound folder is a valid answer, not an error. It flags the ambient global-config
   case ("read-only — claim or `--as` to act") so a later "send refused" isn't a surprise. `--json` for
   scripts.
2. **`musterd --version` / `-v` / `version`** — prints the `@musterd/cli` `package.json` version, read
   at runtime via `createRequire`. Intercepted in `main()` _before_ the help path so it isn't
   swallowed.
3. **`inbox --from <name>` / `--act <act>`** — narrow the listing (and the `--all` firehose) to one
   sender / one act type. A **lens, not a mutation**: when a filter is active the read cursor is left
   untouched (treated as a peek), so a narrowed view can't silently mark the rest of the inbox read.
4. **`accept`/`decline` auto-targeting** — without an explicit `--reply-to`/`--meta in_reply_to`, an
   `accept`/`decline` points at the **latest still-open `request_help`/`handoff` for this member** and
   inherits its thread, so closing the loop is one command. An explicit reply target always wins; when
   nothing is open it errors with guidance (`--reply-to <id>`, `see musterd inbox --json`).

### Why this shape

- **No wire change.** All four ride existing read/send paths. `whoami`/`--version` are pure local
  reads; the filters narrow a list the client already fetches; auto-targeting is one extra inbox read
  the client resolves into the same `meta.in_reply_to` the user would have typed.
- **Same predicate everywhere.** Auto-targeting reuses `openActionNeeded` (ADR 024/025) — the exact
  open-vs-done set the comeback summary and the reachability nudge use — so "the request I'm
  answering" means the same thing across surfaces.
- **Safe by default.** Filtering never advances the cursor; auto-targeting never overrides an explicit
  target and refuses rather than guessing when nothing is open.

## Observability & Evaluation

**Traces** — these are local CLI ergonomics, not coordination acts, so most emit no span. The one with
a downstream signal is `accept`/`decline` auto-targeting: the `send` it produces is a normal envelope
on the team timeline (ADR 051), now carrying a correctly-resolved `meta.in_reply_to` + inherited
`thread` — so thread-completion analytics (time-to-`resolve`, ADR 025) get _more_ complete linkage,
not less, because the reply is no longer dropped or mis-threaded by a hand-typed id. `whoami`/`version`
/inbox-filters are read-only and phone home nothing.

**Eval** — success metric: the share of "answer a request" interactions completed in **one command**
with a correctly-linked `in_reply_to` (target ~100% when an open request exists), and the share of
onboarding sessions that run `whoami`/`--version` and proceed without reading a binding file by hand.
**Dataset**: the onboarding-retry transcripts (2026-06-25) and the 2026-06-29 dogfood, where the
`inbox --json | parse | --reply-to` workaround and the "which seat am I?" confusion are the recorded
baseline. **Baseline**: pre-067, `accept` required a 3-step parse and `--act handoff` was a no-op.
Coverage: `cli.e2e.test.ts` (whoami text+json, `--act`/`--from` narrowing leaves the cursor put,
accept auto-target hits the latest open request + errors when none) and `version.test.ts`.

**Experiment** — none built yet, named for batond: across seeded "reply to a teammate's request"
tasks, compare task-completion turns and mis-threaded-reply rate for auto-targeting vs explicit
`--reply-to` — does removing the parse step measurably cut the turns an agent burns to close a loop
(an MAST coordination-overhead signal)?

## Consequences

- A fresh agent confirms its identity and version in one read each, and answers a request in one
  command — the first-five-minutes friction is gone.
- `inbox` gains a real filter the `--act` flag previously only pretended to have; the firehose is
  narrowable without a mutation.
- Four more commands/flags to keep documented (help text, `04-cli.md` tree) — all additive, all
  reversible by simply not using them; no migration.
- Builds on ADR 024/025 (`openActionNeeded`), ADR 036 (read vs act identity), and closes the
  "CLI ergonomics" roadmap item.
