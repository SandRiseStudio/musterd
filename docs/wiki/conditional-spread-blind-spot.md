# The conditional-spread blind spot

TypeScript's excess-property check fires on a direct object literal and not on a spread — so `...(x ? { typoed_name: x } : {})` compiles clean, and the field silently never arrives.

## The rule, precisely

Excess-property checking is a *freshness* check on object literals assigned to a typed target. A spread element is not part of that check: the spread's own type is computed, then merged, and unknown keys arriving that way are tolerated rather than flagged. Everything in this codebase that says `...(cond ? { field: value } : {})` is therefore **unchecked for the field's name** — the pattern is used constantly and correctly for omitting optional fields, which is what makes it a good hiding place.

## The measured instance (2026-09-05; falsify: check out `1edda93c~1`, change `commands/claim.ts:403` to `workspaceKey:`, and run `pnpm --filter @musterd/cli exec tsc --noEmit` — it compiles, and the field still does not reach the wire)

`HttpClient.claim` forwarded the caller's key into the frame builder:

```ts
...(input.workspace_key !== undefined ? { workspace_key: input.workspace_key } : {}),
```

`buildClaimFrame`'s input field is **`workspaceKey`** — that builder is the one place the CLI's camelCase becomes the wire's snake_case. So the property was unknown to the target type, the spread hid it, `frame.workspace_key` was always `undefined`, and the body omitted it. `pnpm typecheck` was green and would have stayed green.

The caller's comment said the field protected the folder's own live session; it had never been sent. Fixed in [#1339](https://github.com/SandRiseStudio/musterd/pull/1339).

## What it looks like when the guard is back

The repair was not to correct the spelling — that leaves the trap armed — but to use **one name from caller to builder**, so the mistake becomes a direct-literal error at the call site:

```
src/commands/claim.ts(403,5): error TS2561: Object literal may only specify known
properties, but 'workspace_key' does not exist in type '{ ... workspaceKey?: string; }'.
Did you mean to write 'workspaceKey'?
```

That error is the whole point: a typo that was silent is now a compile error, and the compiler even suggests the fix.

## Where to look for more

Highest risk is any place a spread crosses a **naming convention boundary** — camelCase options into a snake_case wire frame, or a config object into a schema-parsed payload. The value is optional there by design, so nothing downstream complains.

`grep -rn '\.\.\.(.*_.*:' packages/*/src --include='*.ts' | grep -v '\.test\.'` finds spreads placing snake_case keys, which is where a camel/snake mismatch can live. It is a starting list, not an answer — most hits are correct wire-frame assembly, and reading each one is the work.

Two habits that avoid it without a grep:

- **One name until the wire.** Convert at a single boundary function, never by hand at each call site.
- **Assert on what leaves.** A test that reads the socket write or the POST body catches this regardless of what the types permit — see [resolved then dropped](resolved-then-dropped.md) for why end-to-end field assertions are the only reliable check on this class.

## Related

- [Double-gated tests](double-gated-tests.md) — a test that cannot run is wrong for years; here it is a *check* that cannot fire.
- [Correct by coincidence](correct-by-coincidence.md) — the sibling where the value is present but stands in for something it is not.
