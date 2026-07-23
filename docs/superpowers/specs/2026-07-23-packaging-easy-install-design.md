# Packaging / Easy Install — Design

Date: 2026-07-23  
Status: accepted (implemented under ADR 156)  
Refs: [ADR 156](../../decisions/156-packaging-release-and-brew.md)

## Goal

Users install a **current** musterd via npm/`npx` or Homebrew, and the first-run path fails clearly
on Node/ABI problems instead of crashlooping.

## Scope

| In | Out |
|---|---|
| Lockstep npm release script (`pnpm release`, human-gated) | CI publish / OIDC |
| Publish `@musterd/telemetry` + bump to 0.3.0 | Embedding `/live` in CLI (ADR 062) |
| Homebrew npm-wrapper tap | `homebrew-core`, bottles, SEA/binary |
| `engines` + CLI Node gate + doctor packaged notes | Windows service |

## Design

### Release

Publish order: protocol → telemetry → server → mcp → cli.  
`pnpm release --dry-run` builds/packs only. Real publish requires human npm credentials.

### Homebrew

Tap: `SandRiseStudio/homebrew-musterd`. Formula installs `@musterd/cli@version` with Node ≥22.

### Post-install

- Package `engines.node >=22`
- CLI exits early if Node major &lt; 22
- Doctor tells packaged users how to upgrade; `service refresh` remains checkout-only

## Human checklist

1. `npm login` (org `musterd`)
2. Clean `main`: `pnpm release` (not dry-run)
3. `git tag v0.3.0 && git push origin v0.3.0`
4. Create/push `SandRiseStudio/homebrew-musterd` from `packaging/homebrew/`
5. Smoke: brew + npm → `musterd init`
