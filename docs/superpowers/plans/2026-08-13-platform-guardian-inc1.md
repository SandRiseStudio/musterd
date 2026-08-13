# Platform Guardian Increment 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (musterd note: no writing
> subagents — ADR 150 / AGENTS.md. Execute inline in the izzo seat, lane `01KZY2014PFVFAWQTTYD9WPS3X`.)

**Goal:** A pure-code guardian LaunchAgent that probes daemon health every ~2 minutes,
auto-remediates `publisher_failed` and post-refresh `crashloop`, and alerts (OS notify +
role-addressed ask from a `guardian` service seat) for every other incident class — zero model
tokens, ever.

**Architecture:** A new `packages/cli/src/guardian/` module holds pure, injected-dependency logic
(classify → damp → act); `packages/cli/src/service/guardian.ts` mirrors `service/autorefresh.ts`
for LaunchAgent lifecycle; `commands/service.ts` wires `--guardian` install/uninstall/tick and a
status line. Tier map is a team-policy knob read at tick time. Spec:
`docs/superpowers/specs/2026-08-13-platform-guardian-design.md`.

**Tech Stack:** TypeScript, vitest (TDD, injected clocks/runners like the ADR 219 and autorefresh
tests), launchd plists via the existing versioned builder, daemon HTTP API.

## Global Constraints

- Zero model calls anywhere in this increment (spec: "pure code, end to end").
- Recency hard rule: classification keys only on live `/health`, `launchctl` `last exit`/`runs`,
  and log lines newer than daemon boot. Never a raw log tail (spec §3).
- Damping: one remediation attempt per class per hour, then forced alert; attempt state in a local
  stamp file, never the DB (spec §5).
- Remediations shell the existing guarded paths (`service refresh --live`, restart
  last-known-good); never reimplement bounce logic (spec §2).
- The guardian never merges, never pushes, never edits code — this increment has no fix-PR tier.
- Repo gates: build whole repo before typecheck; `pnpm lint` and `pnpm format:check` are separate;
  never `pnpm format`; never prettier on `docs/`; THE GIT LOOP (branch → PR → squash auto-merge).
- ADR numbering: reserve via `pnpm adr:next` + stub at execution time (ADR 223 pattern) — the plan
  calls it `ADR-G` throughout.

---

### Task 1: Incident classification — pure function over injected signals

**Files:**
- Create: `packages/cli/src/guardian/classify.ts`
- Test: `packages/cli/src/guardian/classify.test.ts`

**Interfaces:**
- Produces: `type GuardianSignals`, `type Incident`, `classify(s: GuardianSignals): Incident[]`
  used by Tasks 3–4 and the tick in Task 6.

- [ ] **Step 1: Write failing tests** covering, at minimum:

```ts
import { describe, expect, it } from 'vitest';
import { classify, type GuardianSignals } from './classify.js';

const healthy: GuardianSignals = {
  now: 1_000_000,
  health: { ok: true, bootedAt: 900_000, schemaOk: true, dbPathExpected: true },
  launchd: { lastExit: 0, runs: 1 },
  publisherLog: { freshFailure: false },
  errLinesSinceBoot: 0,
  httpErrorRateSinceBoot: 0,
  reaperStormSinceBoot: false,
  lastRefreshAt: null,
};

it('healthy signals classify to no incidents', () => {
  expect(classify(healthy)).toEqual([]);
});

it('publisher failure with a healthy daemon is publisher_failed', () => {
  const out = classify({ ...healthy, publisherLog: { freshFailure: true } });
  expect(out).toEqual([{ class: 'publisher_failed' }]);
});

it('climbing runs + fresh err lines within 30m of a refresh is crashloop', () => {
  const out = classify({
    ...healthy,
    launchd: { lastExit: 1, runs: 5 },
    errLinesSinceBoot: 12,
    lastRefreshAt: 1_000_000 - 10 * 60_000,
  });
  expect(out.map((i) => i.class)).toContain('crashloop');
});

it('unreachable health + nonzero last exit, no recent refresh, is daemon_down', () => {
  const out = classify({
    ...healthy,
    health: null,
    launchd: { lastExit: 1, runs: 3 },
  });
  expect(out).toEqual([{ class: 'daemon_down' }]);
});

it('stale err lines (older than boot) never classify — the 8-day-old-log ghost', () => {
  // errLinesSinceBoot is already boot-filtered by the collector; classification trusts it,
  // so zero fresh lines + reachable health is healthy even if a huge stale log exists.
  expect(classify(healthy)).toEqual([]);
});
```

Also: `schema_drift` (`schemaOk: false`), `wrong_db` (`dbPathExpected: false`), `error_rate`
(`httpErrorRateSinceBoot` above a named floor constant), `presence_churn`
(`reaperStormSinceBoot`), and multi-incident ordering (auto classes first).

- [ ] **Step 2:** `pnpm vitest run src/guardian/classify.test.ts` in `packages/cli` — expect FAIL
  (module not found).
- [ ] **Step 3:** Implement `classify.ts`: the `GuardianSignals`/`Incident` types and a pure
  decision ladder exactly matching the spec §4 table. `Incident = { class: GuardianClass }` with
  `GuardianClass = 'publisher_failed' | 'crashloop' | 'daemon_down' | 'schema_drift' | 'wrong_db'
  | 'error_rate' | 'presence_churn'`. Constants: `CRASHLOOP_REFRESH_WINDOW_MS = 30 * 60_000`,
  `ERROR_RATE_FLOOR` (pick 25/boot-window, named and commented).
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `guardian: incident classification over injected recency-keyed signals`.

### Task 2: Signal collection — recency-keyed, everything injected

**Files:**
- Create: `packages/cli/src/guardian/signals.ts`
- Test: `packages/cli/src/guardian/signals.test.ts`

**Interfaces:**
- Consumes: `GuardianSignals` from Task 1.
- Produces: `collectSignals(deps: SignalDeps): Promise<GuardianSignals>` where `SignalDeps`
  injects `fetchHealth()`, `launchctlPrint()`, `readSince(path, epochMs)`, `statMtime(path)`,
  `now()`. Used by Task 6's tick.

- [ ] **Step 1:** Failing tests with fake deps: health JSON mapped (including absent `bootedAt` →
  fall back to launchd start, commented); err-log lines filtered to `> bootedAt` (fixture with old
  + new lines proves old lines are dropped); publisher `build.log` fresh-failure = failure marker
  AND mtime newer than last success marker; unreachable `/health` (fetch throws) → `health: null`,
  never a thrown tick.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. Parse `launchctl print gui/<uid>/<label>` for `last exit code` and
  `runs` with a tolerant regex (absent → `{ lastExit: 0, runs: 0 }`). Reuse existing health-fetch
  helper from `packages/cli/src/service/` if one exists (grep `\/health` there first — #780 gave
  readers a server-naming discipline; follow it: always the explicitly configured server, never a
  folder binding).
- [ ] **Step 4:** Pass. **Step 5:** Commit.

### Task 3: Damping + stamp file + heartbeat

**Files:**
- Create: `packages/cli/src/guardian/damp.ts`
- Test: `packages/cli/src/guardian/damp.test.ts`

**Interfaces:**
- Produces: `loadStamp(path)`, `saveStamp(path, s)`, `shouldAttempt(s, cls, now)` (false within
  `3_600_000` of last attempt for that class), `recordAttempt(s, cls, now)`,
  `recordTick(s, now)` (heartbeat), `dueDailyHeartbeat(s, now)`. Stamp is JSON at
  `~/.musterd/guardian/stamp.json` (path passed in, never computed here).

- [ ] **Step 1:** Failing tests: first attempt allowed; second within an hour refused (→ caller
  escalates to alert); attempt for class A does not block class B; corrupt/absent stamp file loads
  as empty (never throws); `dueDailyHeartbeat` true once per 24h.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (pure functions + tiny fs wrappers).
- [ ] **Step 4:** PASS. **Step 5:** Commit.

### Task 4: Actions — remediate and alert, attributed to the guardian seat

**Files:**
- Create: `packages/cli/src/guardian/act.ts`
- Test: `packages/cli/src/guardian/act.test.ts`

**Interfaces:**
- Consumes: `Incident` (Task 1), damping (Task 3).
- Produces: `actOn(incidents, deps): Promise<GuardianActionReport>` with `deps` injecting
  `runService(args: string[])` (shells `musterd service …`), `osNotify(item)` (from
  `../notify/os.js`), `sendAsk(body: string)` (daemon HTTP send, `act:'ask'`,
  `meta.species:'consult'`, `meta.tier:'standard'`, addressed to the `platform` holder resolved
  via the members-by-role read — the ADR 227 server-side filter), `audit(action, detail)`
  (best-effort POST; swallow failure with a local log line — the daemon may be down), `tiers`
  (the policy map, Task 5), damping deps.
- Behavior under test, per spec §4/§5:
  - `publisher_failed` + tier `auto` + attempt allowed → `runService(['refresh','--live'])`,
    `recordAttempt`, audit `guardian.remediated`.
  - same class, attempt refused by damping → no run; `osNotify` + `sendAsk`; audit
    `guardian.escalated`.
  - `crashloop` + `auto` → `runService(['restart','--last-known-good'])` **and** alert (acts and
    tells). If no such flag exists on `service restart`, the step below adds `--last-known-good`
    plumbed to the preserved-prior-build path ADR 152 already keeps; verify by reading
    `service.ts` refresh preservation code before writing the test.
  - any alert-tier class → `osNotify` + `sendAsk` + audit `guardian.alerted`; tier `observe` →
    audit only.

- [ ] **Step 1:** Failing tests (fake deps capture calls). **Step 2:** FAIL.
- [ ] **Step 3:** Implement `act.ts`; if `--last-known-good` needs adding to
  `commands/service.ts` restart, do it here with its own small test (reuse the ADR 152 preserved
  build dir; refuse with a clear error when none exists).
- [ ] **Step 4:** PASS. **Step 5:** Commit.

### Task 5: `guardian_tiers` team-policy knob

**Files:**
- Modify: server policy schema (grep `stakes_defaults` in `packages/server/src` for the storage +
  validation seam; add `guardian_tiers?: Record<GuardianClass, 'observe'|'alert'|'auto'>`)
- Modify: `packages/cli/src/commands/team.ts` (`team policy --guardian-tier <class>=<tier>`,
  read-merge-write like the existing knobs, admin-only, audited `policy.change`)
- Test: colocated `.test.ts` files beside each

**Interfaces:**
- Produces: `getGuardianTiers(policy): Record<GuardianClass, Tier>` — absent knob returns the
  spec §4 default table (defaults live in `packages/cli/src/guardian/classify.ts` as
  `DEFAULT_TIERS`, imported by both sides via protocol if needed — check where policy types live
  and follow that boundary).

- [ ] **Step 1:** Failing tests: default map when knob absent; a set knob overrides one class and
  leaves the rest at default; invalid class/tier rejected with a usage error; read-merge-write
  never clobbers other policy keys (the residency-policy lesson, `team.ts:70`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit. Note: this touches `packages/server` + protocol → FEATURE_EPOCH check
  (ADR 148): a policy knob is not client-visible capability; do NOT bump. Say so in the commit body.

### Task 6: LaunchAgent lifecycle + tick + `service status` line + control probe

**Files:**
- Create: `packages/cli/src/service/guardian.ts` (mirror `service/autorefresh.ts`: ctx object,
  plist from the versioned builder, install = write plist → bootout old → bootstrap, uninstall,
  label `com.musterd.guardian`, interval 120s, logs to `~/.musterd/guardian/guardian.log`)
- Modify: `packages/cli/src/commands/service.ts` — subcommands `service --guardian
  install|uninstall`, tick entry `service guardian-tick` (what the plist runs: collect → classify
  → tiers → act → recordTick), and a guardian line in `service status` (last tick age from stamp,
  last incident from stamp, tier map source), following #780's which-server discipline
- Test: `packages/cli/src/service/guardian.test.ts` + additions to `commands/service.test.ts`

- [ ] **Step 1:** Failing tests: plist content (node binary + `['guardian-tick']`, interval 120);
  install writes seat-token env `MUSTERD_SERVICE_TOKEN_FILE=~/.musterd/guardian/seat-token`
  (mirror `service.ts:413`); tick wiring calls collect/classify/act in order with real modules and
  fake deps; status renders `guardian: last tick 40s ago, no incident, tiers: defaults` and a
  loud line when the stamp is stale > 10 minutes (instrument-silence: guardian dead ≠ quiet).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Control probe at install** — install ends by running the tick once against a
  fixture `publisherLog.freshFailure=true` signal override (`--control-probe` flag) with actions
  stubbed to dry-run, asserting the alert path produces its notify payload; print
  `control probe: alert path fired ✓`. Test this flag. Commit.

### Task 7: The `guardian` seat — roster provisioning

**Files:**
- Modify: `packages/cli/src/commands/service.ts` (guardian install ensures the seat exists:
  mirror the `AUTOREFRESH_SEAT` flow at `service.ts:1217` — announce/claim as `guardian`,
  `kind: service`, write seat token to `~/.musterd/guardian/seat-token`)
- Roster home (`/Users/nick/musterd/revive`): `guardian` seat toml with `roles = ["platform"]` —
  via `musterd role assign guardian platform` run in the roster home at arm time, NOT a DB edit
  (standing trap), and only at the live-arming step below.

- [ ] **Step 1:** Failing test: install creates/reuses the service seat idempotently (second
  install does not duplicate; mirrors the autorefresh idempotency test — read it first).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit.

### Task 8: ADR + wiki runbook + gates + PR

**Files:**
- Create: `docs/decisions/<ADR-G>-platform-guardian-pure-code-on-call.md` — number via
  `pnpm adr:next`; content = spec's Decision/Observability&Eval condensed, Status accepted,
  the two-week class-promotion review pre-registered
- Create: `docs/wiki/platform-guardian.md` — runbook: what each class means, where the stamp/log
  live, how to flip a tier, how to read the control probe; follow `docs/wiki/README.md`
  conventions (ryder owns `docs/wiki/**` surface — coordinate: `team_send` heads-up before
  opening the PR, small single-file addition)
- Modify: spec status line → `implementing (<ADR-G>)`

- [ ] **Step 1:** Write ADR + wiki page. **Step 2:** `pnpm build && pnpm typecheck && pnpm lint &&
  pnpm format:check && pnpm adr-numbers:check && pnpm vocab:check && pnpm obs-evals:check &&
  pnpm wiki:check && pnpm test` — all green.
- [ ] **Step 3:** Commit. Open PR (THE GIT LOOP), `lane_update` with branch, `lane_submit` after
  merge.

### Task 9: Arm and verify live (after merge + autorefresh pickup)

- [ ] `musterd service --guardian install` under Node 22 PATH (`process.execPath` embedding trap);
  confirm `launchctl print` shows it loaded; control probe line printed.
- [ ] `musterd role assign guardian platform` in the roster home; `musterd role list` shows the
  holder; diff sibling worktree bindings afterward (binding-clobber trap).
- [ ] Watch two ticks in `~/.musterd/guardian/guardian.log`; `service status` shows the guardian
  line; send one deliberate `observe`-tier flip and back via `team policy --guardian-tier` to
  prove the dial.
- [ ] `team_send status_update` with the armed state; note the two-week eval review date
  (arm date + 14d) in the lane detail.

## Self-review

- Spec coverage: §1→T6, §2→T4/T7, §3→T2, §4→T1/T5, §5→T3, §6→T6 (status line, control probe,
  heartbeat in T3), Eval→ADR in T8, arming→T9. Deferred items correctly absent.
- No placeholders; interfaces named consistently (`GuardianSignals`, `Incident`, `GuardianClass`,
  `DEFAULT_TIERS`, stamp helpers) across tasks.
- Types: `classify` consumes exactly what `collectSignals` produces; `actOn` consumes `Incident[]`
  + tiers map from Task 5.
