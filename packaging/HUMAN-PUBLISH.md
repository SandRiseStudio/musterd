# Human publish checklist (ADR 156)

Agents prepare the release path; **only a human with npm org access** runs the real publish.
Do not mark roadmap item `packaging-easy-install` shipped until this list is done.

## Prerequisites

- [ ] Logged in: `npm whoami` shows an account with publish rights on `@musterd/*`
- [ ] Clean `main` at the SHA you intend to release (`git status` clean, CI green)
- [ ] Dry-run once: `pnpm release --dry-run` (builds + packs; no registry write)

## Publish

- [ ] `pnpm release` (default version **0.3.0**; or `--version X.Y.Z`)
- [ ] Confirm on npm: `@musterd/protocol`, `telemetry`, `server`, `mcp`, `cli` all at the new version
- [ ] `git tag v0.3.0 && git push origin v0.3.0` (match the version you published)
- [ ] Commit the version bumps from `pnpm release` if they are not already on `main` (prefer bump-in-release PR, then tag)

## Homebrew tap

- [ ] Create GitHub repo `SandRiseStudio/homebrew-musterd`
- [ ] Copy `packaging/homebrew/musterd.rb` → `Formula/musterd.rb` (see `packaging/homebrew/README.md`)
- [ ] `pnpm bump-brew-formula --version 0.3.0` if the in-repo formula lags the publish
- [ ] Push the tap; smoke:
  ```bash
  brew tap SandRiseStudio/musterd
  brew install musterd
  musterd --version
  musterd init
  ```

## npm / npx smoke

```bash
npm i -g @musterd/cli@0.3.0
musterd --version
musterd init
```

## After success

- Mark roadmap item `packaging-easy-install` shipped with the merge PR that landed tooling **and** note the publish tag in the blurb, or open a tiny docs PR once the registry is live.
- Close / resolve any human lane opened for “publish to npm”.
