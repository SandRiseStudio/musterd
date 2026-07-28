# 175 — MCP spec 2026-07-28 readiness: canaried seams, SDK-gated adoption

- Status: accepted — 2026-07-28. Authored by stanley (lane `01KYN3C5WJ8598FXC7H7248G96`),
  nick-directed. Number **175** — renumbered twice in one day (172 and 173/174 were both taken by same-day ADRs between branch and PR); next free above ADR 174 at PR time.
- Date: 2026-07-28
- Builds on: [ADR 144](144-mcp-tool-surface-measure-then-craft.md) (the tool-surface arc whose
  telemetry/repair/coercion seams this pins; its increment 6 condition resolves here),
  [ADR 120](120-harness-model-attestation-seam.md) (the clientInfo capture the new spec breaks),
  [ADR 108](108-probe-safe-autojoin.md) (probe safety, which the new spec strengthens),
  [ADR 012](012-agent-primer.md) (the primer that rides MCP `instructions`),
  [ADR 135](135-build-provenance-every-runtime.md) (the degrade-to-silence posture version reporting follows).

## Context

The MCP spec release candidate `2026-07-28` (published today, final after a 10-week validation
window) makes the protocol stateless: the `initialize`/`initialized` handshake is removed, protocol
version / clientInfo / capabilities travel in `_meta` on every request, a mandatory
`server/discover` RPC carries `instructions` + serverInfo + capabilities, every result gains a
required `resultType`, and `tools/list` results must carry `ttlMs`/`cacheScope`. Roots, Sampling,
and Logging are deprecated outright. Tool schemas open to full JSON Schema 2020-12 — which for a
zod-based SDK strongly suggests the supporting release is a major version, plausibly a zod-4
migration.

musterd's exposure is unusually narrow, by prior construction: stdio only, tools only, strict
request/response, no sessions, no pinned protocol version (negotiation is fully delegated to
`@modelcontextprotocol/sdk`), no roots/sampling/logging, no MCP-path auth, no MCP client role. The
spec's headline changes are therefore mostly no-ops here — and three of its moves _validate_ standing
musterd decisions: explicit handles as tool arguments over session state (how lanes, messages, and
threads already work), routing mid-loop reachability around MCP server-initiated messaging (ADR
088's choice — the machinery MRTR just deleted is machinery we never depended on), and stderr-only
logging.

What the spec bump does threaten is concentrated in **seams that fail silently**:

- Four monkey-patches on SDK internals (`packages/mcp/src/index.ts`, install order load-bearing):
  the OTel span wrapper, the ADR 144 bounce counter, repair hints, and argument coercion — all keyed
  on `server.server.setRequestHandler` and the zod method literal `schema.shape.method.value`. Every
  one is defensive: an unrecognized schema reads as "not ours" and passes through. Correct for
  robustness, and exactly what makes an SDK reshape a _quiet_ death — telemetry, repair, and
  coercion just stop, with no crash.
- Prose anchors: the bounce classifier (`BOUNCE_RE` in `toolTelemetry.ts`, copied in `repair.ts`)
  matches the SDK's validation-error wording. If the wording changes, every bounce reclassifies as
  a generic `error` and the ADR 144 headline eval silently flatlines.
- ADR 120's clientInfo capture rides `server.server.oninitialized` — a hook the stateless protocol
  never fires.

**The risk is not hypothetical — writing the canaries caught a live degradation the same day.** SDK
1.30.0 (bumped in #454, hours before this ADR) stopped embedding the zod issue JSON in its
validation-error prose; `repair.ts` had been parsing that JSON for its hints, found nothing, and
every specific repair hint ("act must be one of …; closest to what you sent is `status_update`")
had silently degraded to the generic line. All unit tests still passed — they fed the old format.
Only a test through the real SDK could see it.

## Decision

1. **The seams are pinned by canaries that fail loudly, before any adoption work.**
   `packages/mcp/src/sdkSeams.test.ts` drives the real SDK (`InMemoryTransport` + real `Client`,
   daemon-free) and asserts the anchors themselves: `methodOf` against the SDK's actual request
   schemas, `BOUNCE_RE` against real bounce prose, the specific repair hint on a genuine zod bounce,
   seam composition order, and serverInfo. The daemon-backed e2e tests in `toolTelemetry.test.ts`
   are named part of the canary set. An SDK bump that detaches a seam is a red CI run naming the
   broken primitive — never a quiet telemetry gap discovered weeks later.
2. **Repair hints no longer depend on SDK prose for their content.** `instrumentToolRepair`
   captures each tool's zod shape at registration and re-validates bounced arguments itself,
   regenerating the exact structured issues the SDK saw. The embedded-JSON parse remains as
   fallback. Only bounce _detection_ (`BOUNCE_RE`) still reads SDK wording — one prose anchor,
   canaried, instead of two.
3. **Spec adoption is gated on the SDK shipping 2026-07-28 support.** No hand-rolled
   `server/discover`, no bypassing the SDK's negotiation — musterd has never pinned a protocol
   version and does not start now. The adoption checklist below is executed by its own lane
   (`01KYN3CKJESBYW55NZGBFXY6XD`, opened gated) when the SDK lands.
4. **Roots, Sampling, and Logging stay unadopted.** They are deprecated in the RC; musterd never
   used them and already follows the suggested migrations (tool parameters, direct provider APIs,
   stderr). Recorded so nobody adds one during the deprecation window.
5. **`serverInfo.version` is package truth, never a literal.** A hardcoded `'0.2.0'` sat beside a
   `0.3.1` package.json; under the new spec serverInfo rides `server/discover` and every result's
   `_meta`, making the drift a public fact. `version.ts` reads `package.json` at load and degrades
   to `'0.0.0'` rather than throw (the ADR 135 posture).

### Adoption checklist (SDK-gated — the Phase B lane executes this)

1. Bump the SDK and run the canaries **first**; fix where each points. Expected failure sites:
   `methodOf` (if request schemas move to zod 4 / standard-schema), `BOUNCE_RE` in both files (if
   the prose changes), `hintForIssue` in `repair.ts` (zod 4 renames `invalid_enum_value` →
   `invalid_value`, `options` → `values`), `harness.test.ts` (a stateless client never sends
   `initialize`).
2. Verify `server/discover` serves the primer `instructions`, the ADR 154 icons, and the correct
   serverInfo from existing `McpServer` config. Pin that discover does **not** arm the ADR 108
   autojoin: discover + `tools/list` from a fresh client, assert no seat claimed.
3. Set `tools/list` `ttlMs: 3_600_000` and the private/session-scoped `cacheScope` value (exact
   enum name from the final schema). The surface is static per process but seat/role-scoped — it
   must never be cached across identities. Assert registration order is deterministic rather than
   adding a sort.
4. Tolerate `resultType` everywhere results are inspected: `classifyToolResult`, and the
   `computeSurface` byte-weight capture (reads only `res.tools`; pin it).
5. Migrate ADR 120 capture: read `_meta['io.modelcontextprotocol/clientInfo']` (or the SDK's parsed
   accessor) at the tools/call seam via a pure `harnessFromClientInfo` reusing the existing
   `sanitize` bounds; memoize once per process; keep the `oninitialized` path for legacy-handshake
   clients; first capture wins.
6. Echo serverInfo in result `_meta` only if the SDK does it automatically — never hand-patch
   results.
7. Rewrite the protocol facts in `docs/architecture/05-mcp.md` (instructions-on-initialize becomes
   instructions-on-discover; the validate-before-handler seam note if the SDK's flow changed) and
   close this checklist in place.

If the SDK requires zod-4 tool schemas, migrating the 20 flat shapes in `tools/*.ts` becomes its
own increment inside the adoption lane — mechanical but wide, and not to be smuggled into the bump
commit.

### Deferred, deliberately (recorded here, no lanes yet)

- **`outputSchema` for the structured tools** (`team_send`, `team_inbox_check`, the lane tools):
  previously rejected for token weight; JSON Schema 2020-12 doesn't change that calculus. Gate
  measure-first — use the existing `SurfaceRender` byte attestation to quote the exact `tools/list`
  delta before adopting.
- **SEP-414 trace propagation**: extract `traceparent`/`tracestate`/`baggage` from request `_meta`
  in `instrumentTools` and parent the `musterd.tool.call` span, joining the ADR 089–091 delivery
  ledger to harness traces end-to-end. Independent of everything above.
- **ADR 144 increment 6 resolves per its own terms**: the condition it named ("the MCP spec may
  adopt discovery-tier schemas (#2808) — if that lands broadly, increment 6 collapses") has fired.
  #2808's namespacing+discovery proposal landed as `server/discover` plus cacheable, deterministic
  `tools/list` — spec mechanism, prompt-cache economics, no bespoke `get_more_tools`. We build
  nothing.

## Observability & Evaluation

**Traces.** No new events. The canaries guard the _existing_ ADR 144 telemetry pipeline — their
value is that `tool_call_stats` keeps meaning what it means across SDK bumps.

**Eval — dataset and baseline.** The baseline is the caught incident: on SDK 1.30.0, zero of the
specific repair hints survived (the day-one canary run showed the generic line where "closest to
what you sent is `status_update`" belonged), and no existing test noticed. The target, asserted by
`sdkSeams.test.ts` in CI: every anchor holds or the build is red. The production-side signal for a
missed prose re-anchor is the team's bounce rate (`musterd report`, `tool_calls.bounces`)
collapsing to zero while `error` rises — a rate of exactly 0 across active seats is the suspicious
value, not the good one.

**Guard metric.** A failed canary **blocks the SDK bump PR by design** — the red test is the
mechanism converting "silent seam detachment" into "scoped re-anchor task", and must not be skipped
or weakened to land a bump.

**Experiment.** The steward workflow's SDK watch (one `npm view @modelcontextprotocol/sdk
dist-tags` step, diffed against the lockfile) is the trigger for the gated adoption lane. The
falsifier for this ADR's central bet: if the SDK's 2026-07-28 release lands and the canaries all
stay green _without_ edits, the seams were more stable than claimed and the canary set can shrink;
if the bump requires re-anchoring beyond the named sites, the checklist under-modeled the SDK and
the miss list belongs in the adoption lane's close.

## Consequences

- SDK bumps stop being trust-me changes: #454's own audit ("only four SDK entrypoints imported")
  now has a permanent, executable form, and the next bump self-verifies.
- Repair hints work again on 1.30.0, and their content no longer breaks when SDK wording changes —
  one prose anchor remains (bounce detection), pinned by a canary.
- The 10-week RC window is covered by a gated lane plus one steward step — no new workflow, no
  dependabot adoption decided here.
- Two files intentionally keep private `BOUNCE_RE`/`methodOf` copies (`repair.ts`, `coerce.ts`);
  the canaries anchor the shared definition in `toolTelemetry.ts` and the copies behaviorally.

## Related

- [ADR 144](144-mcp-tool-surface-measure-then-craft.md) — the seams' purpose; increment 6 closes.
- [ADR 165](165-worktree-family-mcp-entry.md) — why the MCP entry carries no env; untouched by the
  new spec.
- Adoption lane: `01KYN3CKJESBYW55NZGBFXY6XD` (gated on the SDK release).
