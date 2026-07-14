# 139 — Live publisher builds protocol first + stamps published tip

- Status: accepted
- Date: 2026-07-13
- Related: ADR 132 (live viewer on daemon origin)

## Context

The `/live` build-publisher (ADR 132) advances `agents-live` to `origin/main` and runs
`pnpm --filter @musterd/web build`, then atomically publishes into `~/.musterd/live/web`. The web
package imports `@musterd/protocol` from that worktree's `packages/protocol/dist`.

After ADR 138 landed, the publisher failed with `MISSING_EXPORT: resolvePosture` — web source was on
the tip, but protocol `dist/` still lacked the new export. The failure left an older `index.html` in
place. The skip condition was “HEAD == origin/main && index.html exists”, so every later poll
**exited without retrying**, and `refresh --live` kickstarted the same no-op.

## Problem

1. Web-only builds go stale when protocol gains exports the UI imports.
2. Skip keyed on `index.html` presence treats a failed publish as success.
3. `refresh --live` could not force a rebuild once HEAD already matched main.

## Decision

1. Build `@musterd/protocol` before `@musterd/web` in the publisher script.
2. Skip only when HEAD == `origin/main` **and** `$WEBROOT/.published-sha` equals that tip (written
   on successful publish).
3. `refresh --live` deletes `.published-sha` before kickstart so a force rebuild always runs.
4. Keep `nodeDir` first on PATH (already true in the generator; reinstall refreshes an old plist
   script that preferred `/usr/local/bin` Node 20).

## Consequences

- Failed publishes retry on the next interval (and on `refresh --live`).
- Protocol+web couples the publisher to a slightly longer build; still cheaper than a wrong bundle.
- Operators must reinstall/regenerate the live agent once (`musterd service install --live` or the
  next CLI that rewrites `build.sh`) to pick up the new script — until then, manual publish works.

## Observability & Evaluation

n/a — ops/script fix; success is “published \<sha\>” in `~/.musterd/live/build.log` after a protocol
export lands, without manual intervention.
