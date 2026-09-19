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

## Unknown is not clean

Three states, not two. A warning that reports only "wrong" and "quiet" leaves *not known* with nowhere to go, so it lands in the quiet one — where it reads as good news.

`provisioningDriftOf` (ADR 408 inc 4) returned `null` for an absent cache, an unparseable one and a genuinely clean one alike, so a seat whose drift record was missing reported exactly like a seat with nothing wrong (2026-09-16; falsify: delete `.musterd/drift.json` on a bound seat, run `team_inbox_check`, and read `structuredContent.warnings`). <!-- claim: defect -->

The population that hits it is the population it exists for. The cache is written on the interrupt-check cadence — the PostToolUse hook — so a seat whose hook is stale or missing never writes one. The census of 2026-09-16 found exactly that on big-body, kimi and ghost. The sharpest case is not absence but **staleness**: a seat whose hook breaks *after* one clean write leaves a zeroed file behind, and absence-only detection stays quiet about it forever.

**Amended 2026-09-19 (izzo, ADR 421):** staleness is the sharpest case *and* the ambiguous one. The hook writes only at a tool boundary, so a record's age is also the seat's silence — measured on izzo 2026-09-18: written 13:25:44, no tool call 13:29→16:12, "167m old — the hook is not running" on the first inbox check after, rewritten by that check's own hook two seconds later. The hook was fine. Age cannot separate a dead hook from a quiet seat; what can is whether a *later* sighting finds the record still older than the first — a boundary passed and nothing wrote. The adapter now reports `stale` only on that second sighting (2026-09-19; falsify: idle a seat past thirty minutes and run `team_inbox_check` once — a `drift_unreadable` warning on that first call is the regression). <!-- claim: defect -->

This is the same family as the rest of this page, with the sign flipped. The other instances were fixes that did not arrive, and every one of them was found because something *looked* wrong. A report that does not arrive looks right.

## The hard half is not crying wolf

A warning that fires on healthy workspaces is one people learn to ignore, so the gate matters more than the detection.

The obvious discriminator is unusable (2026-09-16; falsify: run the adapter from a folder with no `.musterd` and read `client.workspaceDir`): `resolveBindingDir` falls back to `process.cwd()` when its walk-up finds nothing (`packages/mcp/src/binding.ts`), so the adapter's `workspaceDir` is **always** defined and cannot distinguish a seat workspace from a fresh clone or a scratch folder. The gate that does work is the resolver's own predicate — a seat workspace is one carrying `.musterd/binding.json` or `.musterd/workspace.json`, which is precisely what that walk-up accepts. Reusing the predicate rather than inventing one means the two can never disagree about what counts as a seat. <!-- claim: other -->

## Where the hooks live, and why the exclusion is load-bearing

Measured across `agents-kimi`, `agents-big-body` and `agents-ghost` (2026-09-16; falsify: read the `hooks` keys of each file in any seat worktree): <!-- claim: other -->

| file | hook kinds |
| --- | --- |
| machine-wide `~/.claude/settings.json` | `SessionStart`, `UserPromptSubmit` |
| project-local `.claude/settings.local.json` | `Notification`, `PostToolUse`, `PreToolUse`, `SessionEnd`, `SessionStart` |

Every hook the census found stale or missing was project-local. The repair carrier — the machine-wide `SessionStart` — sits in the one file self-heal refuses to write.

So `withinWorktreeOnly` is not merely caution about touching a neighbour's files: **the excluded file is the repair carrier**, and refusing to let a seat's own session rewrite it is what keeps a floor under every other repair. A seat that could rewrite it could remove its own recovery path.

The floor below that is still open. If the machine-wide hook is absent — never provisioned, or removed by hand — nothing repairs and nothing writes, and the adapter is the only surface still running, because the harness loads it directly.
