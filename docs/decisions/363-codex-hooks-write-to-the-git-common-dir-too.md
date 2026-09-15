# 363 — Codex hooks write to the git common dir too: a workspace's own `.codex/hooks.json` is never what codex-cli reads

- Status: proposed — 2026-09-02. Authored by ryder on lane `01M1JBH9CRS6BAEJWJEQDBYHZB`
  (codex-hook attestation), from empirical investigation the same session as ADR 359.
- Date: 2026-09-02
- Relates to: ADR 359 (codex wake trusts its own hooks — the trust-gate half of this same falsifier),
  ADR 031 (`.codex/config.toml` is written per-folder, in-tree — the principle this ADR carves an
  explicit, scoped exception to), ADR 246 (the mechanism this closes the last gap in — resumable
  attestation for codex)
- Lane: `01M1JBH9CRS6BAEJWJEQDBYHZB`

## Context

ADR 359 fixed codex's hook-trust gate; a follow-up fix (same lane) fixed `codexHook.ts`'s broken
attestation auth. Both landed, and the landed-outcome falsifier ADR 359 named — a live codex wake
producing a `residency.session_captured` audit row — still failed. Investigating why turned up a
third, independent cause, found empirically:

**codex-cli resolves `.codex/hooks.json` against the git *common dir*'s root, not the directory it
is actually invoked in.** Every musterd seat workspace (`agents-gptbot`, `agents-ryder`, …) is a git
workspace (a `git worktree`) of one shared checkout (`/Users/nick/agents`). A workspace's `.git` is a
*file* — not a directory — containing `gitdir: <main>/.git/worktrees/<name>`. codex-cli appears to
walk up to that main checkout when locating `.codex/hooks.json`, ignoring the per-workspace copy
musterd's onboarding has always written.

Proved with paired canary tests (identical `.codex/hooks.json`, one hook writing a sentinel file):
- Placed at the workspace (`agents-gptbot/.codex/hooks.json`, where `installCodexHooks` writes it
  today) — the hook never fires. Not even a bare `date > /tmp/x` command.
- The byte-identical file placed at the main checkout (`agents/.codex/hooks.json`) — fires on every
  invocation.
- Critically, the `cwd` codex hands the hook in its stdin JSON is still the **workspace** path
  (`/Users/nick/agents-gptbot`), confirmed by capturing the hook's raw stdin. So a single shared
  `hooks.json` at the common-dir root correctly serves every workspace of that checkout — each
  workspace's `musterd codex-hook` invocation still resolves its own seat's binding via `cwd`, exactly
  as it does today. Nothing about per-seat routing needs to change; only where the file lives.

This has been silently broken for every codex seat since hooks.json was first written, independent
of and prior to both of this session's other fixes — those fixes made the falsifier reachable; this
is what was actually still blocking it.

## Decision

`installCodexHooks`/`removeCodexHooks`/`inspectCodexHookDrift` (`codexHooks.ts`) become common-dir
aware via a new `codexCommonDirRoot(workspaceRoot)`, which parses the workspace's `.git` file and
returns the main checkout's root, or `undefined` when `workspaceRoot` is not a `git worktree` at all
(a plain checkout is already its own common-dir root — nothing extra to write).

- **Install** writes to both the workspace's own `.codex/hooks.json` (unchanged, kept for anyone
  hand-inspecting the workspace, and because a future codex version could fix the resolution bug) and
  the common-dir root's `.codex/hooks.json` (new — what codex actually reads).
- **Remove** touches only the workspace's own copy. The common-dir copy is shared by every workspace
  of that checkout; one seat unprovisioning must not strip hooks another seat's workspace still needs.
  An orphaned common-dir copy with no workspace left needing it is not a leak this function chases —
  the next `musterd init --refresh-hooks` from any surviving workspace re-converges it.
- **Drift inspection** checks the common-dir copy first, since that is what determines whether hooks
  actually fire — a healthy-looking workspace file with a missing or stale common-dir twin is exactly
  the bug this ADR fixes, and must not report clean.

This is a scoped, explicit exception to ADR 031's per-folder/in-tree posture, not a reversal of it:
the common-dir file's *content* is identical to (and driven by) the workspace's own desired state —
it is not a new configuration surface, just the second location codex-cli happens to require for the
one file whose location was never actually a choice.

## Consequences

- Every codex seat's resumable attestation, session capture, and ADR 246 model observation — silent
  since hooks.json was first written — start working the next time a provisioned workspace runs
  `musterd init` or `musterd init --refresh-hooks`.
- A stopgap copy was hand-installed at `/Users/nick/agents/.codex/hooks.json` during the
  investigation to confirm the fix live before building it properly; it is byte-identical to what
  this fix now writes automatically and needs no cleanup, but does not survive a fresh clone or a
  different machine on its own — this ADR's code is the real fix.
- A **second, independent bug** surfaced while testing this: `removeCodexHooksAt`'s JSON merge kept
  a file's stale `hooks` key even when every entry was marker-owned and removed — `{ ...file }`
  already carried the old key, and the conditional re-add only ever overrode it, never deleted it.
  Invisible until a test exercised "remove down to zero survivors," which nothing had before. Fixed
  in the same commit (delete the key explicitly before the conditional re-add).
- Not addressed: whether this is a codex-cli bug worth reporting upstream. The behavior may be
  intentional (hooks scoped to the "project," defined as the git superproject) rather than a defect —
  this ADR treats it as an environmental fact to route around, not a claim about what codex *should*
  do.

## Observability & Evaluation

- **Traces.** `installCodexHooks`'s return value now names up to two paths instead of one — the
  common-dir write's presence in that array is directly observable. `inspectCodexHookDrift`'s new
  common-dir-first check surfaces in `musterd init --check`/doctor output by name ("git common dir").
- **Eval.** Direct unit coverage (`codexHooks.test.ts`): `codexCommonDirRoot` resolves a real
  `git worktree add`-shaped `.git` file correctly, returns `undefined` for a plain checkout and for
  no `.git` at all; `installCodexHooks` writes byte-identical content to both locations;
  `inspectCodexHookDrift` reports drift when the common-dir copy is missing even though the
  workspace's own file is healthy (the exact bug this fixes, reproduced); `removeCodexHooks` never
  touches the shared common-dir copy. The landed-outcome falsifier below is the end-to-end check
  these unit tests can't reach on their own (unit tests don't invoke a real codex binary).
- **Experiment.** None — a location fix with a direct falsifier, not a policy under experimentation.

## Landed-outcome falsifier

After this fix lands and a provisioned workspace runs `musterd init` (or `--refresh-hooks`): one live
codex wake on that seat produces a `residency.session_captured` audit row within seconds of
SessionStart, and the seat's residency row's `resumable_harness`/model reflects a fresh codex
observation instead of whatever harness last attested. Confirmed manually during this investigation
(seat gptbot, real actuator wake, lease `01M1JEXPHN37H0JVES061ANMV0`) with the hand-installed stopgap
in place; re-confirming after the automated fix lands (rather than relying on the stopgap) is the
open item.
