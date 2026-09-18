# `team create` binds the folder you run it in

`musterd team create` auto-binds the current directory to the new team (ADR 036) — run it inside a live seat's worktree and it overwrites that workspace's binding, seat credential and all.

## What it costs (2026-09-17; falsify: in a throwaway directory, write a `.musterd/binding.json` naming any team and seat, run `musterd team create scratch --server <any>`, and re-read the file — if `team`, `claim` and `seat_credential` survive, the auto-bind is scoped and this page is wrong) <!-- claim: defect -->

Measured on seat `ryder`, testing against a throwaway daemon and forgetting which directory the command would bind. One `musterd team create probe --server http://127.0.0.1:4877` from `/Users/nick/agents-ryder`:

- `.musterd/binding.json` was **replaced**, not merged: `team` became `probe`, `claim` became `{mode: seat, name: nick}`, and `seat_credential` was gone.
- `~/.musterd/config.json` had its global `server` repointed at the throwaway daemon and gained a `probe` identity.

The seat credential is **not recoverable** — the daemon stores only its hash. Sibling worktrees were untouched, and the live MCP adapter kept working because it holds its credential in memory, which is exactly what makes this quiet: every `team_*` tool call still succeeds while the file the *next* session will read is already destroyed.

## The repair, if you have done it

1. Restore `~/.musterd/config.json` by hand — `server` back to the real daemon, `current` back to the real team, and drop the throwaway team from `identities` and `knownIdentities`.
2. Rebuild `.musterd/binding.json` with `version`, `server`, `team`, `claim` and `model`. Keep `model_observed` if it is still there — it is this workspace's own measured fact and has nothing to do with the clobber.
3. Mint a replacement bootstrap credential as an admin: `musterd team bootstrap mint --seat <name> --expires-in 1h`, write it into the binding as `agent_key`, then `musterd claim <name>`. That mints a fresh `seat_credential`, `grant` and `session_lease`.
4. `musterd whoami` should read `<seat> on <team> (cli · binding)`. Compare the field set against a sibling worktree's binding before you call it done.

`musterd claim` holds its socket open, so in a non-interactive shell it looks hung after it has already succeeded — check the binding rather than waiting on the command.

## How to test against a throwaway daemon without this

Do not rely on `--server` to keep a command away from your workspace: the flag steers the *daemon*, and the bind is a *local* side effect. Two isolations that do work:

- `MUSTERD_CONFIG=<path>` redirects the global config; `MUSTERD_DB=<path>` gives the daemon its own database. This is what `packages/cli/src/cli.e2e.test.ts` uses.
- Run the whole thing in-process instead. `createServer({ db: openDb(':memory:'), port: 0 })` from `@musterd/server` needs no daemon, no ports and no config — see [claim mirror join](resolved-then-dropped.md#instance-5-sharpens-the-test-advice-the-wire-assertion-is-per-path-2026-09-17) for a case where that replaced a manual daemon probe entirely and became a CI guard in the process.

The general shape: a manual probe against a live rail is the right tool for *finding* something, and the wrong tool for *keeping* it. When the probe needs a real team, a real credential and a real daemon to say anything, that is the signal to move it in-process.

## Related

- [Resolved then dropped](resolved-then-dropped.md) — the class of defect this probe was chasing when it went wrong.
- [The three claim paths](the-three-claim-paths.md) — why `claim` behaves differently depending on which route takes it.
