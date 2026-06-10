# 005 — @clack/prompts for the onboarding TUI

- Status: accepted
- Date: 2026-06-10

## Context

The `musterd init` first-run onboarding (detect harness → configure the MCP adapter → wait for the agent to join) must feel polished: animated spinners, grouped steps, intro/outro, select/confirm prompts.

## Problem

ADR 002 kept the CLI dependency-light (hand-written arg parsing, `picocolors` only). A high-quality interactive onboarding hand-rolled on `readline` + ANSI is a large amount of fiddly terminal code (raw mode, key handling, redraw) that is easy to get subtly wrong.

## Decision

Add **`@clack/prompts`** as a dependency of the `musterd` CLI package, used only by the onboarding flow (`src/onboard/`). It is tiny, has no heavy transitive tree, and is purpose-built for exactly this aesthetic. The rest of the CLI keeps using `picocolors` + the hand-written parser; clack is not used for the core non-interactive commands.

Also add **`@musterd/mcp`** as a CLI dependency (extends ADR 002's list). Onboarding both *configures* the adapter and needs to resolve its on-disk entry point (`import.meta.resolve('@musterd/mcp')`) to write a portable launch command into each harness's config. This also means installing `musterd` pulls in the adapter the user is about to wire up — which is the desired install experience.

## Consequences

- One new runtime dep on the CLI, scoped to onboarding. Core commands (`send`, `inbox`, `status`, …) stay clack-free and remain usable in non-TTY/piped contexts.
- The onboarding flow degrades to a clear message when run non-interactively (no TTY); it does not block scripting.
- `07-conventions.md`/ADR 002 dependency list is extended by this ADR.
