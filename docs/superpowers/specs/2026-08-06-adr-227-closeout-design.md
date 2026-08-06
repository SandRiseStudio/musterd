# ADR 227 close-out — make the shipped role layer honest and measurable

- **Date:** 2026-08-06
- **Owner:** wanderer (design session with nick)
- **Anchor:** ADR 227 (roles as the aptitude layer), audited live 2026-08-06

## Why

A live audit of ADR 227 against the running system (daemon on schema 35, epoch 9) found both
increments substantially shipped and four gaps. This spec closes all four. The shared story: the
ADR's help surface hides half the shipped feature, and its own eval criteria cannot be measured
as written — so the hardening ramp and the role-addressed-send reopening trigger both wait on
evidence nothing collects.

The audit's evidence, verified not assumed:

1. **`musterd role` is two commands wearing one name.** `list|show|create` manage the ADR 029
   *provisioning templates* (local, pure-file); `assign` manages the ADR 227 *team library*
   (`roles/*.toml`). The help catalog documents only the first — `assign` is absent — and
   `role list` in a team context answers the wrong question. Dogfood cost: an operator hand-edited
   `seats/wanderer.toml` because the assign affordance was invisible.
2. **Inc-1's eval criterion is unmeasurable.** The role filter runs *client-side* in the MCP tool
   (`packages/mcp/src/tools/members.ts` filters after fetching the full roster), so the daemon
   never sees that a role query happened. `tool_call_stats` has no parameter column. "Role-filtered
   queries appear within two weeks" and the reopening trigger (filter→send pair) cannot be
   evaluated by anything that exists.
3. **Inc-2's eval was never run.** Three `infra.touch.warned` rows exist (ryder ×2 `refresh`,
   stanley ×1 `agent`); nobody has computed the warn→redirect rate the hardening ramp
   (warn → `--force` → refuse) explicitly waits on.
4. **ADR text drift, both directions.** §3 names migrations as gated — no `migrate` CLI verb
   exists and nothing gates one. Conversely the gate actually covers `agent` and `reset` beyond
   the ADR's list.

## Decision

Two PRs from one lane.

### PR 1 — code

**A. `musterd role` becomes roster-first.**

- `role list`: when the folder resolves to a bound team, fetch the roster (the same
  `client.roster()` call `team_members` uses) and render the **team library first** — role name,
  summary, holders, `(unheld)` where empty — then the existing template output under a labeled
  `provisioning templates (local)` heading. Unbound folder or unreachable daemon → today's
  template-only output, unchanged; scripts and non-team folders see no difference.
- `role show <name>`: a team-role match wins (summary, charter, capability defaults, holders) and
  falls through to the template show otherwise. If both exist, the team role renders with a
  one-line pointer to the template.
- `create` untouched. Help catalog (`packages/cli/src/help/catalog.ts`) gains
  `assign <seat> <role> [--remove] [--force]` in the signature and a summary naming both worlds.
- No renames, no new command: the ADR 144 alias-decay lesson (never rename a shipped surface)
  rules out splitting into a `template` command.

**B. The role filter moves server-side and becomes auditable.**

- The roster GET gains `?role=`. The daemon filters members by `roles[]` and, when the param is
  present, writes a `roster.role_query` audit row `{role, holders}` with the calling seat as
  actor — the exact `infra.touch.warned` pattern (`transport/http.ts`, `store/audit.ts` union
  gains one string). No schema migration.
- `packages/mcp/src/tools/members.ts` passes `args.role` through instead of filtering locally;
  the "no seat holds X — team roles: …" message logic keeps working off the returned data.
  The CLI `role list` team section reuses the same param when it filters.
- **No `FEATURE_EPOCH` bump**: the filter capability shipped with inc 1's bump; this relocates
  plumbing and is invisible to clients. Old clients that never send `?role=` see identical
  behavior.
- Tests: a through-DB integration test asserting the audit row (the standing ADR 103 trap: every
  new act/route lands with one), plus unit tests for the filter and the CLI rendering fallbacks.
  TDD throughout.

### PR 2 — ADR amendment + the eval actually run

- **Run the inc-2 eval now**: join the three existing `infra.touch.warned` rows against
  `messages` for a following ask directed at a `platform` holder; record the warn→redirect rate
  in the amendment. This is the first datum the hardening ramp has ever had.
- **Amend ADR 227**:
  - Observability rewritten around `roster.role_query` — the "countable parameter on that
    existing row" wording dies (it described a column that doesn't exist).
  - The role-addressed-send reopening trigger becomes the concrete join: `roster.role_query`
    audit rows followed within 120s by a directed send from the same seat.
  - §3's verb list corrected to what the gate actually covers (`install|restart|refresh|reset|
    agent`); migrations dropped from the list until a migrate verb exists, with a note that
    ADR 245's ladder gate covers migration collisions.
  - Status line records the amendment date and this spec.
- **Observer stays unheld.** The ADR's own words: "a role without a holder is just a file."
  One line notes that ADR 144 inc 5's MCP scope-by-role now has no live exerciser, so re-holding
  observer is where evidence would come from if that scope narrowing ever needs proof.

## Out of scope

- Role-addressed sends (`to: 'role:platform'`) — stay deferred; this work builds the evidence
  path, not the feature.
- Any hardening-ramp step — the eval result informs it; flipping it is an admin policy act.
- The provisioning-template system itself (ADR 029) — untouched beyond labeling.

## Error handling

- `role list`/`show` degrade to template-only output on unbound folders and daemon errors —
  never a hard failure on the read path.
- An unknown `?role=` value returns the empty-holders result (the MCP tool already renders the
  "team roles: …" hint); the audit row still records the query — a miss is signal too.

## Testing

- Through-DB integration: `?role=` filter correctness + `roster.role_query` row shape.
- CLI: roster-first rendering, fallback rendering, `show` precedence, help-catalog snapshot.
- Eval SQL committed alongside the amendment so the two-week re-run is a copy-paste.

## Workflow

Claim a musterd lane before building. Branch from fresh main; TDD; full `gates` locally
(build → typecheck → coverage → format:check + doc gates, `pnpm lint` separately); squash
auto-merge via THE LOOP; PR 1 then PR 2.
