# Human publish checklist (ADR 156)

Publish uses **`pnpm release`** which calls **`pnpm publish`** (not raw `npm publish`) so
`workspace:*` is rewritten. Current latest: **0.3.1** (0.3.0 was published broken and deprecated).

## Prerequisites

- [x] Logged in: `npm whoami` (org publish rights on `@musterd/*`)
- [x] Packaging tooling on `main` (PR #362)
- [x] Dry-run / real publish path verified

## Publish (done for 0.3.1)

- [x] `pnpm release --version 0.3.1` (protocol → telemetry → server → mcp → cli)
- [x] Confirm on npm: all five packages at 0.3.1 with rewritten deps
- [ ] `git tag v0.3.1 && git push origin v0.3.1` (after version-bump PR merges)
- [x] Deprecate `@musterd/*@0.3.0` (broken `workspace:*`)

## Homebrew tap

- [x] Create GitHub repo `SandRiseStudio/homebrew-musterd`
- [ ] Push `Formula/musterd.rb` at 0.3.1
- [ ] Smoke:
  ```bash
  brew tap SandRiseStudio/musterd
  brew install musterd
  musterd --version
  ```

## npm / npx smoke

```bash
npm i -g @musterd/cli@0.3.1
musterd --version
```
