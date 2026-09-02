# 357 — Codex wake trusts its own hooks: `--dangerously-bypass-hook-trust` is safe when musterd wrote the hooks

- Status: proposed — 2026-09-02. Authored by ryder on lane `01M1J1M1419ZRCCSCMGNW99VXT` (codex
  hooks never fire), from a direct instruction from nick this session ("im fine to use untrusted
  hooks").
- Date: 2026-09-02
- Relates to: ADR 246 (the CLI attests what the harness observed — the mechanism this unblocks for
  codex), ADR 158 (observed over declared), ADR 187/188 (durable model attestation and the graded
  review ladder that consumes it), ADR 354 (wake-lease file channel — the sibling codex-specific
  wake mechanism)
- Lane: `01M1J1M1419ZRCCSCMGNW99VXT`

## Context

`.codex/hooks.json` has been installed in every provisioned codex workspace since before this ADR,
carrying the `musterd codex-hook start/end/post-tool-use` commands that would push resumable
attestation, session capture, and ADR 246 model observation the same way the equivalent hooks do
for every other harness. It has never fired. gptbot's residency row still reads `claude-code /
2026-08-14` while the actuator has resumed codex captures since — every codex row in the fleet has
been unattested this whole time, silently.

The investigation first concluded hooks were simply unimplemented in codex-cli 0.152.1 — a `strings`
scan of the installed binary found zero matches for `SessionStart`, `hooks.json`, etc. That
conclusion was wrong: `grep -c` on the same binary found 298 raw occurrences of "hook" that the
`strings` heuristic missed, and a byte-safe extraction turned up a fully implemented `codex_hooks`
crate — dispatcher, command_runner, and parsers for `session_start`, `session_end`, `pre_tool_use`,
`post_tool_use`, `user_prompt_submit`, `stop`, and `compact`. `codex features list` correctly
reports `hooks stable=true`.

The real gate: every codex invocation requires **persisted hook trust** before enabled hooks run.
`codex exec --help` documents `--dangerously-bypass-hook-trust` — *"Run enabled hooks without
requiring persisted hook trust for this invocation. DANGEROUS. Intended only for automation that
already vets hook sources."* Persisted trust is presumably granted through an interactive
confirmation on first encounter with a project's hooks — a prompt that can only fire on a TTY.
musterd's wake path spawns `codex exec --json ...` headless, `stdio: ['ignore', 'pipe', 'pipe']`,
never a TTY (`packages/cli/src/host/backends/codex.ts:139`). That prompt can never fire, so trust is
never persisted, and hooks silently no-op on every actuated wake, forever — not a bug in our config,
a structural mismatch between an interactive-consent feature and a headless actuator.

**Empirical confirmation.** Fresh throwaway project, `.codex/hooks.json` with a `SessionStart` hook
writing to a sentinel file:
- `codex exec "reply with just: hi"` (no bypass flag): clean run, session id issued, model replied,
  sentinel file never created.
- Same run + `--dangerously-bypass-hook-trust`: stdout shows `hook: SessionStart` /
  `hook: SessionStart Completed`, sentinel file created. Hooks fire.

**This was a deliberate prior decision, not an oversight.** `buildCodexResumeArgs`
(`packages/cli/src/host/backends/codex.ts:26`) carries the doc comment *"production wake never
carries a trust, sandbox, or approval bypass"*, `codexWakeEnv` (line 46-52) says the child env is
"never an ambient agent key, grant, binding override, or smoke/trust control," and
`codex.test.ts:53-64` has a named test — `'uses the workspace flag only for fresh exec and never
passes a bypass'` — asserting neither arg builder's output matches
`/dangerously|bypass|approval|ignore-user-config/i`. All three predate this ADR and were authored by
nick on 2026-08-03, before codex's hook-trust gate was understood to be the actual blocker.

## Decision

Trust codex hooks by default on every musterd-actuated wake: add `--dangerously-bypass-hook-trust`
to both `buildCodexFreshArgs` and `buildCodexResumeArgs` in `packages/cli/src/host/backends/codex.ts`
(the single spawn site, `attempt()` at line 139, consumes both). Update the two doc comments to state
the new policy and why. Replace the guard test with one asserting the flag IS present (the inverse
assertion), so the invariant stays enforced — just the opposite one.

**Why this is safe despite the flag's own warning ("automation that already vets hook sources"):**
the thing `--dangerously-bypass-hook-trust` protects against is a hooks.json an attacker or an
untrusted collaborator planted in a workspace, running arbitrary commands the operator never agreed
to. That is not this shape. `.codex/hooks.json` is written by musterd's own onboarding
(`packages/cli/src/onboard/harnesses/codex.ts`) into workspaces musterd itself provisions, carrying
exactly the `musterd codex-hook *` commands musterd ships — the same commands every other harness's
equivalent hooks already run unreviewed on every session, because musterd wrote them too. "Untrusted"
here means *not interactively re-confirmed by a human at a terminal that will never exist*, not
*attacker-controlled*. The distinction is the whole argument: bypassing hook trust for a hooks.json
we authored is not a new attack surface, it is skipping a confirmation step that was already
guaranteed to answer yes and structurally could never be asked.

This does not extend to hooks.json content from any other source (a plugin marketplace hook, a
project a human onboarded by hand with their own hooks.json) — those still deserve the interactive
gate, and this ADR does not touch how humans use codex interactively. It is scoped to musterd's own
actuated wake path only.

## Consequences

- Once landed, `musterd codex-hook start/end/post-tool-use` fires on every codex wake the same way
  the equivalent hooks already do for other harnesses. Four rails light up for codex without further
  code: resumable attestation, session capture, ADR 246 model observation (the codex rollout JSONL
  carries the model per turn), and an honest `local-session-live` read.
- `codex.test.ts`'s guard test must flip from asserting absence to asserting presence of the bypass
  flag — a silent regression back to the old args would be exactly as invisible as this bug was.
- Landed-outcome falsifier: after the flag ships, one live codex wake on gptbot should produce a
  hook-originated audit row within seconds of spawn, and gptbot's residency row should flip its
  `resumable_harness`/model fields to codex instead of sitting on the 2026-08-14 claude-code
  observation.
- Sibling lane `01M1J1KC6H` (roster `wakeable` → ADR 189 host liveness) is a separate mechanism and
  must not be conflated with this one; neither substitutes for the other.

## Limitations

- This trusts musterd's own hook authorship, not codex's hook engine in general — a future plugin or
  marketplace hook riding along in the same `.codex/hooks.json` would also run unreviewed under this
  flag. Nothing today writes third-party hooks into a musterd-provisioned `.codex/hooks.json`, but
  nothing enforces that either; if that changes, this ADR's safety argument needs re-examination.
- Untested against a codex-cli version where `--dangerously-bypass-hook-trust` does not exist or is
  renamed — the flag was discovered empirically against 0.152.1's `--help` output, not from upstream
  documentation, so an upstream release could remove or rename it without warning.
