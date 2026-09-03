# 374 — One name for seat occupancy: `claim` on the CLI, and what `team_join` is called

- Status: accepted — 2026-09-03 (nick: "lets go with 2b" — increment 1 and 2b build together; 2a stays the fallback if the eval fails)
- Date: 2026-09-03
- Builds on: [ADR 075](075-p3.3-cli-claim-surface-migration.md) (the claim handshake), [ADR 087](087-seat-resume-vs-claim-one-verb.md) (`musterd claim` ≡ MCP `team_join{}`), [ADR 296](296-terminology-architecture.md) (one meaning per word), the surface survey (`docs/wiki/command-and-tool-surface-map.md`, #1245, collision 3)
- Lane: item 5 of the survey's ranked recommendation

## Context

Occupying a seat — the first thing every seat does — has three names:

| Surface | Name | What it does today |
| --- | --- | --- |
| CLI | `musterd claim [<name>] [--role <r>]` | the v0.3 claim handshake (ADR 075) from a bound folder: occupy your bound seat, or name a seat / role pool; writes `binding.json`; blocks on admin approval (ADR 087) |
| CLI | `musterd join <slug> --as <name> [--key] [--grant] [--surface]` | the same handshake, naming the team explicitly; the bootstrap form for a fresh folder |
| MCP | `team_join {as?, role?}` | the same handshake from an MCP session (ADR 007 "explicit activation"; ADR 087 Fix D: "`musterd claim` (≡ MCP `team_join{}`) is the one command an agent runs") |

ADR 075 named the mechanism the **claim** handshake; ADR 087 wrote the equivalence down but left the names. `claim` is also the verb for lanes (`lane claim` / `lane_claim`) and seeds (`seed claim`), and `requests` decides *claim* requests. So a human reading the CLI learns "claim" is how you take a seat; an agent reading the MCP tools learns "join"; the docs use both for one act.

The survey graded this collision third of seven. It is the one whose fix has the largest blast radius, which is why it gets an ADR rather than a lane: measured 2026-09-03, `team_join` appears in 50 docs and 23 non-test source files; `musterd join` in 8 docs and 9 source files; `musterd claim` in 32 docs and 28 source files.

## Problem

Give seat occupancy one name per surface, and ideally one name across both, without breaking a single installed seat, and without spending more on the rename than the confusion costs.

## Decision

**The name is `claim`.** It is the handshake's name (ADR 075), the CLI's start-here verb, and the word every other object already uses for "take ownership" (`lane claim`, `seed claim`). `join` is a second spelling of it, not a second act.

### Increment 1 — the CLI: `join` folds into `claim` (no-regret, do now)

- `musterd claim` absorbs `join`'s three bootstrap flags: `--key <mskey_…>` (the team agent key; already read from `MUSTERD_AGENT_KEY` / the binding), `--grant <token>` (skip the approval lane), and `--surface <s>`; the team comes from the existing global `--team <slug>`. `musterd claim ryder --team revive --key mskey_…` is byte-for-byte what `musterd join revive --as ryder --key mskey_…` did.
- `musterd join` stays dispatchable as a **hidden alias** for one epoch (the way `nudge` was folded into `inbox --waiting`, #1250): dropped from the help catalog, kept in `bin.ts`, prints one line naming the new spelling on stderr.
- Help and guidance say it once: "`claim` — get onto the team from this folder (MCP: `team_join`)".

### Increment 2 — the MCP tool: nick's call, with the cost in front of him

Two options, decided on this PR:

- **2a. Rename to `team_claim`, keep `team_join` as a deprecated alias for one epoch.** One word across both surfaces. Cost: the alias itself is small (the `lane_ready` / `team_memory_search` pattern, #1253), but `team_join` is the most-cited tool name in the repo — 50 docs, 23 source files, the guidance skill (a `GUIDANCE_CONTENT_VERSION` bump reaching every seat), ADR 007/087 prose, and every seat's harness memory. Falsifier for "worth it": a fresh seat, reading only `musterd help` and the tool list, describes seat occupancy with one word.
- **2b. Keep `team_join`; make the two descriptions name each other.** `team_join`'s description opens "Claim your seat (the CLI spelling is `musterd claim`, ADR 075)"; `claim`'s summary ends "(MCP: `team_join`)". Two words remain, but each surface tells you the other's. Cost: two strings. This is the ADR 296 "one meaning per word" floor: neither word carries a second meaning, they just differ per surface.

**Decided (nick, 2026-09-03): 2b now, 2a only if the survey's falsifier fails after 2b** — that is, if a fresh seat still cannot say what `team_join` does in `claim`'s words. The rename's cost is real and its benefit is the difference between "one word" and "two words that explain each other", which 2b buys for two strings.

### Not in this ADR

`lane claim`, `seed claim`, `lane_claim`: object-qualified, one meaning each, unchanged. `requests` (claim requests): unchanged. `team_leave` / `unbind`: a different question (parity, survey item 6).

## Consequences

- One CLI verb for occupancy; the start-here list stays `init · claim · status · next`.
- A human and an agent can each name the act in one word; under 2b the words differ per surface but never collide with another meaning.
- `join.ts` becomes a thin alias; its bootstrap flags live in `claim.ts`, which is where a reader of `musterd help claim` already looks.
- The hidden-alias-for-one-epoch pattern is now used three times (`nudge`, `lane ready`, `join`); if a fourth appears, it should become a helper rather than a convention.

## Observability & Evaluation

- **Eval (increment 1):** after the fold, `grep -r "musterd join" docs packages` returns only the alias note and ADR history; `musterd help` lists `claim` once under Team & seats. Falsifier: any provisioning path, hook, or skill that still emits `musterd join` as the spelling to use.
- **Eval (increment 2b):** `team_join`'s description contains `musterd claim`; `claim`'s catalog summary contains `team_join`. Falsifier: a seat's first `team_join` result that does not say the word "claim".
- **Retirement of the `join` alias:** one FEATURE_EPOCH after increment 1 lands, remove the dispatch case, the way #1253 removed `lane_ready`.
