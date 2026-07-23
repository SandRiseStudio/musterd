# Human publish checklist (ADR 156)

Publish uses **`pnpm release`** → **`pnpm publish`** (rewrites `workspace:*`).

**Latest: 0.3.1** (tag `v0.3.1`). `0.3.0` was published broken (`workspace:*` leaked) and deprecated.

## Done

- [x] `pnpm release --version 0.3.1` — all five `@musterd/*` on npm
- [x] Deprecate `@musterd/{protocol,server,mcp,cli}@0.3.0`
- [x] Tag `v0.3.1` pushed
- [x] Tap `SandRiseStudio/homebrew-musterd` with working formula (node@22)
- [x] Smoke npm: `/Users/nick/.npmglobal/bin/musterd --version` → 0.3.1
- [x] Smoke brew: `/opt/homebrew/bin/musterd --version` → 0.3.1

## User install

```bash
# npm / pnpm / npx
pnpm add -g @musterd/cli@0.3.1
# or: npx @musterd/cli@0.3.1 init

# Homebrew
brew tap SandRiseStudio/musterd
brew trust sandrisestudio/musterd   # once
brew install musterd
musterd init
```
