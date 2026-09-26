# 454 — Untrack the Grok hooks file

- Status: accepted
- Date: 2026-09-26
- Lane: `01M3DK2BMDAJSXHB51DC7GA2VK`
- Relates to: [ADR 352](352-grok-first-class-harness.md) §9, [ADR 168](168-hook-content-drift.md)

## Context

ADR 352 §9 committed `.grok/hooks/musterd.json` in this product repo. The commands are portable (`musterd` on `PATH`), unlike `.grok/config.toml`, which carries a machine launch path and is gitignored. Cursor and Codex hooks were already gitignored: `musterd init --refresh-hooks` writes them per workspace.

Every Grok hook command ends with a marker and the build's feature epoch (`# musterd-grok-notify e24`, and the same tag on the other five). `FEATURE_EPOCH` is 24 as of 2026-09-26. A bump rewrites the file. Because the file is tracked, that rewrite is a modification in every seat workspace that has run init against the new epoch.

## Problem

The portable-command reason is true of the commands and false of the file as a git object. The epoch tag is local to the build that last wrote the hooks. A committed copy therefore goes dirty on every epoch bump, with no content decision in the diff. Seat builds then stamp `<sha>-dirty` into `dist/build.json`, which the roster reads as adapter-versus-daemon skew. Measured as the one committed harness hook file: `.cursor/hooks.json`, `.codex/hooks.json` and `.opencode/plugins/musterd.js` are already ignored; this file was the exception.

## Decision

This product repo stops tracking `.grok/hooks/musterd.json`. `.gitignore` names that path. `musterd init` and `musterd init --refresh-hooks` remain the writers, as they are for the Cursor and Codex hook files.

ADR 352 §9 is not rewritten. Its product-repo clause is reversed here. User projects are unchanged: they may still commit the hooks file.

## Consequences

- A seat whose copy matches the old blob loses the file on pull. The next `musterd init --refresh-hooks` rewrites it, and git then ignores it. The doctor already reports a missing Grok hook and names that command.
- A seat whose copy is already epoch-dirty keeps the local file through the removal. Once it matches the ignore, further epoch bumps do not show in `git status`.
- The working copy in a provisioned workspace stays. Only the index entry goes.
- User projects that commit their own copy still go dirty when they upgrade musterd and refresh hooks. That is their repository's choice, and this record does not change it.

## Observability & Evaluation

n/a — not agent-facing: a gitignore, with no traces, dataset or model behaviour. Falsifier: bump `FEATURE_EPOCH`, run `musterd init --refresh-hooks` in a seat workspace, and `git status` must not name `.grok/hooks/musterd.json`. `git ls-files -- .grok/hooks/musterd.json` stays empty, and `git check-ignore` names the pattern.
