# Structured results have two audiences

A tool result that carries `structuredContent` has two kinds of reader, and each half of the result is written for only one of them — so where a warning is put decides whether a seat ever sees it.

## The shape of the mistake

An MCP tool result may carry both halves: `content: [{type:'text', text}]` and `structuredContent`. The spec lets a client render either. In practice some harnesses render the structured half and drop the text entirely — the Claude Code desktop app does (2026-09-16; falsify: call `team_inbox_check` with unread rows and compare what the session is shown against the `text` the tool builds at `packages/mcp/src/tools/inboxCheck.ts`). <!-- claim: other -->

So any fact that exists **only** in `text` is invisible to those clients. Appending a warning to the prose looks like it works, because it does work — on the other half of the fleet, and in every test that reads `text`.

## The instance that cost a false negative

`buildSkewWarning` (ADR 135) compares the running adapter's `dist/build.json` stamp against the daemon's `/health.build` and says, in so many words, that this session runs stale tools and needs a rebuild plus a `/mcp` reload. It was correct, it degraded properly (silent unless both sides are known), and it was wired into the two surfaces that matter — including `team_inbox_check`, which the SessionStart hook makes every seat's minute-0 call, with a comment saying so.

It reached nobody on a structuredContent-rendering harness from whenever `structuredContent` was added to that path until #1470's follow-on (2026-09-16; falsify: check out the commit before that fix, run a `team_inbox_check` with a build mismatch and unread rows, and read only `structuredContent`). <!-- claim: defect -->

Measured consequence, 2026-09-16: a seat reviewing PR #1470 ran a default inbox check, saw the exact stall the PR claimed to fix, and nearly reported a correct fix as failing. Their adapter (pid 90535) had booted 2026-09-15 21:05:52 from pre-fix dist while the daemon was current — the precise condition the warning exists to announce. It fired, went into `text`, and was discarded. They recovered the fact by hand from `ps` and `stat` instead.

The asymmetry is what hid it: the **empty**-inbox path returns `textResult(...)`, which carries no `structuredContent`, so the warning was always visible exactly when it mattered least. A busy seat — the one most likely to be running a long-lived stale adapter — took the other path every time.

## The rule

**A warning that can change what a seat decides belongs in `structuredContent`, not only in the prose.** Carry the sentence too (`text`), so printing clients are unaffected, and carry the facts beside it so a structured client can render its own line or act on it. In this repo that is the `ToolWarning` union in `packages/mcp/src/tools/format.ts` — a `kind` discriminator, one agreed `text`, and the fields behind it.

One wording, never two. A warning that reads differently in its structured and prose forms is two warnings that will drift.

## Why the tests did not catch it

Every test over these warnings read `text`, so none of them could see the defect — the same shape as the trap in [what is waiting for me](what-is-waiting-for-me.md), where a green unit test modelled a fetch the product never performs. The falsifier that works reads **only** `structuredContent` and asserts the fact is present: `packages/mcp/src/structuredWarnings.e2e.test.ts`, driven through the real tool over `tools/call` against a real daemon.

Fixture trap met while writing it, worth one line: `function f(build: string | undefined = DEFAULT)` called as `f(undefined)` re-supplies the default, so the "unstamped adapter stays silent" case silently tested a stamped one. Take the argument explicitly when `undefined` is a case you mean to test.

## Family

This is the third instance in 48 hours of one pattern — a correct fix that does not reach the seat that needs it:

- the inbox drain, where the unit tests passed over arguments the product never passes (see [what is waiting for me](what-is-waiting-for-me.md));
- the `accept`-is-the-verdict guidance correction, which landed on main 2026-09-14 and was still missing from seven of nine seat worktrees two days later;
- this one, where the warning was rendered into a field the client discards.

The general case — making a fix actually reach a seat at the moment it decides something — is named and unowned.
