# Contributing to musterd

Humans and agents both contribute here. Same git path, same bar.

Please read and follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Start here

[`AGENTS.md`](./AGENTS.md) is the execution contract — read it before writing
code. The docs are written so you can execute without judgment calls; when you
would otherwise make one, write an ADR instead.

Then, in order:

1. [`docs/architecture/00-overview.md`](./docs/architecture/00-overview.md) through `07`
2. [`docs/design/brand.md`](./docs/design/brand.md) (glossary §5 is load-bearing)
3. [`SPEC.md`](./SPEC.md) (the normative protocol)

The five glossary terms — **Team, Member, Presence, Surface, Act** — mean
exactly one thing each. Use them, and only them, for those concepts.

## Dev setup

Requires **Node ≥22** and **pnpm**.

```bash
pnpm install
pnpm -r build
pnpm test            # unit + integration + scenarios
pnpm test:scenarios  # the flagship 3-pane scenario (Scenario C)
```

To dogfood the CLI from this checkout (not the published `@musterd/cli`):

```bash
pnpm -r build
node packages/cli/dist/bin.js status
```

The bin runs `dist/`, not `src/`. Rebuild after a source change.

## How a change lands

There is one git workflow ([ADR 106](./docs/decisions/106-unified-git-workflow.md)).
GitHub enforces it (squash-only, `main` protected). The playbook is in
[`AGENTS.md`](./AGENTS.md); traps that stall a PR are in
[`docs/wiki/shipping-a-pr.md`](./docs/wiki/shipping-a-pr.md).

1. Branch from fresh `origin/main` (`feat/` / `fix/` / `docs/<slug>`). One
   branch per lane.
2. Work and commit. Intermediate commits are squashed away.
3. Before pushing, the fast local smoke is `pnpm typecheck && pnpm format:check`.
   That is a speed check, not a duplicate of CI — **do not** run the full suite
   locally to pre-verify. CI is the authority.
4. Open a PR. Auto-merge waits for the required `gates` check
   (build → typecheck → test → coverage → format:check → change-adr:check) and
   squash-merges when green. Walk away; don't poll.
5. If you fall behind `main`, rebase onto `origin/main` and
   `git push --force-with-lease`. Never merge `main` into your branch. Never
   `git push --force`.

`pnpm format` is safe to run: since ADR 284 the writer and the checker read one
scope list, so on a clean tree it changes nothing and on yours it touches only
what `format:check` would flag (`pnpm exec prettier --write <files>` on your own
files still works if you prefer it):

```bash
pnpm format
pnpm format:check
```

A change is done when the [definition of done](./docs/architecture/07-conventions.md)
checklist is satisfied, including: docs and code never disagree at the end of a
commit.

## Protocol, ADRs, and secrets

- Never change `@musterd/protocol` schemas without an [ADR](./docs/decisions/).
- Get the next ADR number from `pnpm adr:next` (never by reading `origin/main`
  yourself), then push the branch as a draft PR before you write the ADR.
- Never log secrets. The team **agent key**, **grants**, and human
  **credentials** (`mskey_` / `msgr_` / `mscr_`) are shown once and stored only
  as `sha256` on the server / chmod-600 config on clients.
- No new runtime dependency without an ADR.

## What this repo is not building yet

Sandbox runtime, schedule enforcement, team-to-team federation, iOS/Slack
surfaces, a Python SDK — see [`ROADMAP.md`](./ROADMAP.md). Keep the schema
fields that anticipate these; don't wire behavior to them.

## License

Contributions land under the [MIT License](./LICENSE).
