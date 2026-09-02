# 354 — The wake lease travels on disk as well as in the environment, for harnesses that sanitize the second

- Status: proposed — 2026-09-02
- Date: 2026-09-02
- Authored by dolly on lane `01M1HM8EEK8Q5370VTZ3ZQ5ZFQ`; the finding was made monitoring a gptbot wake
  for lane `01M1G310Y76M5JF4WCTCVMD68E`'s acceptance, and the mechanism behind stanley's 2026-09-01
  gptbot wake loop.
- Builds on: [ADR 241](241-a-wake-verifies-against-its-own-lease.md) (the lease token this carries by a
  second route), [ADR 236](236-sleeping-host-defers.md) (why the second route must be an
  attestation and not a default), [ADR 238](238-verify-waits-for-its-own-evidence.md) (the defer-and-kill
  path that was firing on the actuator's own session), [ADR 131](131-harness-residency-wake-ledger-host.md) §6 (the env the
  actuator hands a child), [ADR 321](321-opencode-first-class-harness.md) §8 (honest degradation when a harness
  has no channel — the opencode precedent in #1162).

## Context

ADR 241 made a wake verifiable: the actuator puts `MUSTERD_PROVENANCE=wake` and
`MUSTERD_WAKE_LEASE=<id>` in the child's environment, the child's MCP adapter attests them on its
claim, and the actuator credits the wake only to a presence row carrying that exact lease. Anything
else on the roster is "held by another session" and — per ADR 238 — the attempt defers and the child
is killed, so a wake never pays for a seat it did not occupy.

Every step of that assumes the environment reaches the adapter. On Claude Code it does. On Codex it
does not:

- **Measured 2026-09-02, codex-cli 0.150.1**: `codex exec --json` with a throwaway MCP entry whose
  command dumps its environment to a file. The MCP stdio server starts with **twelve variables** —
  `HOME PATH USER SHELL TMPDIR LANG LOGNAME TERM` and four others — and no `MUSTERD_*`, with
  `MUSTERD_PROVENANCE=wake MUSTERD_WAKE_LEASE=…` set on the codex process. Falsify: repeat the probe
  (`scripts/` has no wrapper; it is a one-line `codex exec -c mcp_servers.x.command=sh -c
  'mcp_servers.x.args=["-c","env > /tmp/x"]'`) and find a `MUSTERD_` line in the dump.
- **The daemon audit for lease `01M1HKKABRN1N967MXZY1EAG19`** (gptbot, 2026-09-02 10:45): the
  session's claim reached the daemon at 10:45:37 as `claim.occupied surface=codex` — through the
  MCP, with no hook rows at all — and the codex rollout shows a healthy review (89 events over 88s:
  `team_wake_context`, `team_next`, `lane_board`, `git show`, `vitest run`). At 10:46:50 the actuator
  recorded `wake_deferred: the seat is held by another session (provenance session, not lease
  01M1HKKABRN…)` and killed it, four seconds after its last tool call. The next lease deferred on the
  corpse's still-fresh transcript (`local-session-live`, `LOCAL_SESSION_LIVE_MS` = 10 min); the one
  after that repeated the kill.
- **Scale**: gptbot's last `residency.woke` is 2026-08-27. In the three days to 2026-09-02: 0 woke,
  13 deferrals of the held-by-another shape, 11 `local-session-live`, 2 `lease_expired`. Falsify:
  `sqlite3 ~/.musterd/musterd.db "select action, json_extract(detail,'$.reason'), count(*) from audit
  where target='gptbot' and ts > (strftime('%s','now')-3*86400)*1000 group by 1,2"`.

Nothing in the chain is wrong on its own. `codexWakeEnv` sets the variables. The adapter defaults
provenance to `session` when unset and, correctly, never defaults the lease (ADR 236). ADR 241's
verification does what it says. ADR 238's kill does what it says. The composition kills every codex
wake at the verify window, and the seat that cannot finish a turn is also the seat that could not
report what the turn cost (lane `01M1G310Y7`), so the loop was invisible to the priced rail too.

Codex hooks are not a bypass: `musterd codex-hook start` would inherit the env and attest correctly,
but no hook row appears in the audit for that session, and the claim that mattered was the MCP's.

## Decision

The actuator hands the lease over **twice**: in the environment as before, and as a file
`<workspace>/.musterd/wake-lease.json` written immediately after spawn:

```json
{ "lease_id": "01M1…", "provenance": "wake", "harness": "codex",
  "spawner_pid": 4242, "started_at": 1788371121000, "expires_at": 1788372921000 }
```

The MCP adapter reads the file under two conditions, both required:

1. **Only when the environment is silent on both provenance and lease.** Env always wins. A harness
   that forwards it — Claude Code — never evaluates the file, so nothing changes there. An explicit
   `MUSTERD_PROVENANCE=session` is an assertion by whoever launched the adapter, and the file does
   not out-argue it.
2. **Only when `spawner_pid` is the adapter's own parent process, and the file is unexpired.** The
   adapter's parent is the harness process the actuator spawned (the `ppid` rung in
   `sessionLiveness.ts` already rests on this). A human session opened in the same workspace during
   the wake window has a different parent and reads nothing. That condition is what makes the file
   an attestation with a source rather than a default — ADR 236's line, kept.

The actuator clears the file when the run settles, success or failure, and only if it still carries
the same lease (a slow settle must not delete a newer wake's file). `expires_at` is the work order's
bound, so a file that survives a crash is dead on its own.

Written for codex now, because codex is the harness with the measurement. The channel is generic
(`WakeLeaseFileSchema` in protocol; writer in `cli/host/wakeLeaseFile.ts`; reader in
`mcp/wakeLeaseFile.ts`); opencode adopts it by calling the writer, once someone has measured that
opencode strips the env too rather than assumed it.

Rejected:

- **Baking the lease into `[mcp_servers.musterd].env`** — it is per-wake; a config rewrite per wake
  is a race against a human session in the same workspace and leaves the last lease behind.
- **Defaulting provenance to `wake` when the adapter cannot tell** — ADR 236, exactly.
- **Making the actuator not kill a session whose provenance is `session`** — that undoes ADR 238 for
  every harness to fix one, and "held by another" is still the right verdict when it is true.

## Consequences

- A codex wake is credited to its lease again: `residency.woke` with `lease_matched: true`, no kill,
  and the priced rail (lane `01M1G310Y7`) sees it.
- The lease file is a new artefact in `.musterd/`. It is `0600`, contains no secret (a lease id is a
  daemon-minted opaque correlation token, ADR 241), and is short-lived by construction.
- A residual, named rather than fixed: even with attestation right, the actuator's not-mine path
  kills a session the actuator itself spawned ninety seconds earlier, in its own workspace, whose
  thread id it just wrote into `binding.json`. That evidence exists and is not consulted before the
  kill. Left for a sibling lane; this ADR fixes the attestation, not the judgement.

## Observability & Evaluation

- **Traces.** `claim.occupied` rows from `surface: codex` carrying `provenance: wake` and a
  `wake_lease`; `residency.woke` rows for codex seats with `lease_matched: true`;
  `residency.wake_deferred` rows with reason `held by another session … provenance session` for
  codex seats going to zero.
- **Eval.** Unit: the reader honours a file only for a matching `spawner_pid` and only unexpired;
  `loadMcpConfig` prefers env in every combination, including an explicit `session`; the codex
  backend writes at spawn (with the child's pid) and clears at settle on both exits
  (`wakeLeaseFile.test.ts`, `wake-lease-fallback.test.ts`, `codex.test.ts`).
- **Experiment.** Pre-registered: the first gptbot wake after this lands on the host actuator
  produces a `residency.woke` row with `lease_matched: true` and no `held by another session` deferral
  for that lease. Falsify: the audit shows the deferral shape again for a lease minted after the
  actuator picked up this build (check `/Users/nick/agents/packages/cli/dist/build.json` first — the
  actuator runs that dist, not this workspace's).
- **What it must not move.** Claude Code seats' provenance and lease attestation — env-first means
  the file is never read there. Falsify: a claude-code wake's `claim.occupied` row differs in any
  field from the pre-ADR shape.
