# 135 — Build provenance for every runtime: dist stamps + client build attestation

- Status: accepted — 2026-07-13
- Date: 2026-07-13

## Context

Three runtimes execute musterd code, and each can silently drift from `origin/main`:

1. **The daemon** — guarded since ADR 130: `/health` names its boot commit, `service status` warns
   when it falls behind `origin/main`.
2. **The global `musterd` CLI** — a pnpm link into a checkout's `packages/cli/dist`. It knows its
   `package.json` version (ADR 067), which moves rarely, but not the commit its dist was built from.
3. **The MCP adapter** — runs from **each agent worktree's own** `packages/mcp/dist`: N independent
   copies, and each is stale in _two_ dimensions — the dist on disk can lag `main`, and the _running
   process_ lags the dist until the harness reloads it (`/mcp` reload).

The result was a recurring "but I merged it — why isn't it live?" failure, three times in one recent
dogfood session (model attestation dark for a day, a merged UI change presumed unshipped, an agent
about to bounce the shared daemon to "fix" what wasn't broken). Each incident cost real time because
the stale runtime _looked_ fine: nothing anywhere named what code was actually running.

ADR 130 also left a latent gap: the daemon resolves its build ref by `git rev-parse HEAD` at boot,
which reports what the **checkout** is — not what the **dist** is. Check out `main` and forget to
rebuild, and the daemon attests fresh while running stale: the exact lie the mechanism exists to kill.

## Decision

**1. Every package build stamps its dist.** `scripts/stamp-build.mjs` runs as the tail of each TS
package's build (`tsc && node …/stamp-build.mjs`) and writes `dist/build.json` — the current git SHA,
suffixed `-dirty` when the worktree has uncommitted changes (a build cut from uncommitted edits must
not masquerade as a clean commit). Dependency-free, never throws; outside a git checkout it writes
`ref: null`, and every consumer degrades to **silence, never a guessed ref**. `packages/web` is
deliberately NOT stamped — the web bundle is decoupled from the daemon by design (ADR 132), and the
web surface must never warn about its own build.

This supersedes ADR 130's "no build-time stamping" non-goal: the stamp is the truth of _what the code
is_; `rev-parse` is only what the checkout says. The daemon's `resolveBuildRef` now prefers its dist
stamp and falls back to `rev-parse` for pre-stamp dists.

**2. Clients attest their build on connect, exactly like `model` (ADR 101).** A shared
`readBuildStamp(import.meta.url)` helper in `@musterd/protocol` reads the _caller's_ package stamp
(the caller passes its own `import.meta.url`; a zero-arg helper would report protocol's stamp for
everyone). Then:

- **MCP**: `ClaimFrame.build` (optional, ≤64 — additive, no protocol version bump, same precedent as
  `model`/`driver`), read once at config load so the running process reports the code it **booted**
  with. No heartbeat re-attestation: a build only changes on process restart, which is a fresh claim.
- **CLI**: an `x-musterd-build` header on every HTTP request, installed onto the ambient presence
  touch (ADR 057/119) with the same sticky `COALESCE` as `model`. Unlike model there is **no ADR 121
  agent-key gate**: the model gate exists because a model is a harness fact a human must not stamp;
  build attests the _binary itself_, which a human's (possibly stale) CLI genuinely has — stale human
  CLIs are squarely in scope.
- **Storage**: `presence.build` (migration v17, additive + nullable — pre-migration rows and
  unstamped clients read NULL and render as silence). `build` is NOT persisted into `binding.json`:
  it is a per-process runtime fact, re-read from the dist at every boot.

**3. Two-level skew semantics.** Level 1 (ADR 130, unchanged): the **daemon** vs `origin/main` —
needs git, surfaced by `service status`. Level 2 (new): **every client** vs **the daemon's build** —
pure SHA equality, offline, no git at render time. Level 1 keeps the daemon current, so
client == daemon ⇒ current. A differing client may legitimately be _ahead_ (a feature-branch build),
so level-2 wording is always "differs from the daemon", never "behind"; only git-capable surfaces
(doctor) count behind/ahead.

**4. The money surface is the adapter warning about itself.** `team_status` and `team_inbox_check`
append one line when the adapter's own stamp differs from the daemon's `/health.build` (memoized 60s,
so a mid-session `service refresh` is picked up on the next poll):

> ⚠ your musterd adapter (abc1234) differs from the daemon (def5678) — this session runs stale
> tools. Rebuild this worktree (pnpm build) and /mcp reload to pick it up.

Because the running process reports the stamp it booted with, **"rebuilt but forgot `/mcp` reload"
self-incriminates** — the case no local git check can see. The SessionStart hook already routes every
agent to `team_inbox_check` at minute 0, so the warning reaches every agent with no new plumbing.
Those two tools only — warning on every tool call would be nagging without added reach.

A follow-up increment adds the peripheral surfaces: per-member build facets on `musterd status`,
doctor notes (`init --check`), a hook-cheap `init --check-build`, and a roster chip on `/live`.

## Consequences

- "What code is this runtime actually running?" now has one answer per runtime (`dist/build.json`),
  carried to one place (`presence.build`), compared against one reference (the daemon's build).
- A stale MCP adapter — the most common and least visible drift — names itself in the agent's own
  tool output at minute 0, with the exact fix (`pnpm build` + `/mcp reload`).
- `-dirty` builds are honest: displayed with the suffix, stripped before `git rev-list` (a
  `abc-dirty..origin/main` range fails, which would have silently degraded the skew verdict for
  exactly the builds most likely to be skewed).
- Published tarballs ship the publisher's stamp (truthful) or none; every consumer treats an unknown
  build as silence, so packaged installs are unaffected.
- CI's `gates` job builds before typecheck, so CI dists get stamped harmlessly; nothing in CI reads
  the stamps. Wire compatibility is untouched: `ClaimFrame.build` is optional on a plain `z.object`,
  and old adapters simply never send it.

## Observability & Evaluation

- **Traces:** the build attestation itself is presence metadata, not an act — it emits no envelope
  and needs no span. The signals are: `presence.build` on the roster projections (queryable per
  occupancy), the daemon's existing `/health.build` (ADR 130), and the adapter's warning line, which
  appears in the agent-visible tool result where a stale session can be diagnosed post-hoc from the
  session transcript. If skew frequency becomes a question, a counter on warning emissions
  (`musterd.insight.build_skew_warned`) hangs naturally off the existing telemetry seam (ADR 089) —
  deferred until there's a consumer.
- **Eval:** n/a — a mechanical provenance/transport change with no agent-facing model decision to
  score; correctness is pinned by unit + integration tests (stamp read, claim/header/COALESCE
  attestation paths, warning render/silence matrix).
- **Experiment:** n/a — no behavioural variant. The success criterion is operational: the next
  "merged but invisible" incident should be diagnosable in one tool call instead of an hour.
