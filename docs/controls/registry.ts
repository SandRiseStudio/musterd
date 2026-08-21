/*
 * The control registry — every guard we believe is in force, with the date someone last watched it
 * work.
 *
 * ## Why this exists
 *
 * 2026-08-19, four unrelated failures in one day turned out to be the same failure: a control
 * believed to be in force that wasn't.
 *
 * - The root vitest config's 30s ceiling reached **zero of five packages**, because a package-local
 *   config inherits nothing (#918). The timeout everyone believed was protecting `pnpm -r test`
 *   was protecting one command nobody ran before pushing.
 * - A `daemon_down` probe ate its own errors in a bare `catch {}` — 22 raises, one distinct body,
 *   none diagnosable after the fact (#923).
 * - ADR 272 cited ADR 227's measured reopening gate as satisfied. The gate had **never fired** —
 *   zero `roster.role_query` rows have ever been written (#912, #917).
 * - A wiki falsifier could not fail: "re-run the named file alone" is satisfied by a real defect
 *   and by harmless noise alike, so it could never distinguish them (#925).
 *
 * Each is an **absence-class claim** in ADR 294's sense — an assertion that something is being
 * prevented — and absence claims have the longest half-life of any class, because nothing
 * contradicts them. A control that has never been observed to trip is indistinguishable from a
 * control that does not work. The registry's whole job is to make that distinction expensive to
 * ignore, by forcing each control to carry a date.
 *
 * ## The two facts a control must separate
 *
 * The failures above conflate two very different things, so this schema splits them:
 *
 * - **Exercised** ({@link Control.lastExercised}) — when did a human or a test last *run* this
 *   control and watch what it did? This is liveness. ADR 272's gate scores well here: stanley ran
 *   the query twice.
 * - **Tripped** ({@link Control.everTripped}) — has it ever actually *caught* anything? This is
 *   efficacy. ADR 272's gate scores zero: it has never fired.
 *
 * Both are needed and neither substitutes. A control exercised often and never tripping may be
 * guarding something that cannot happen (fine, and worth knowing). A control that tripped once and
 * has not been exercised since may have rotted (not fine, and invisible without a date).
 *
 * ## The counterfactual rule
 *
 * Every control answers {@link Control.counterfactual}: *would this control have caught the
 * incident that motivated it?* The rule is not rhetorical. Applied honestly to a dating check
 * ryder had just built (2026-08-19), the answer was no — it would have passed on the very case
 * that prompted it — and the check was thrown away rather than shipped as reassurance. A control
 * that cannot catch its own motivating incident is decoration, and decoration that reads as
 * protection is worse than nothing.
 *
 * ## Scope of increment 1
 *
 * Deliberately small: the schema, the gate (`scripts/check-controls.ts`, wired into
 * `pnpm format:check`), and the controls whose evidence could be verified from the repo at
 * registration time. It is NOT a complete inventory of the repo's guards, and it does not
 * auto-discover them — an entry lands when someone exercises a control and records what they saw.
 * Growing it is the point; a registry that claimed completeness on day one would be the same
 * absence-class lie one level up.
 */

/** What kind of thing the control is — informational, but it shapes what "exercise" means. */
export type ControlKind =
  /** A CI/format gate that fails the build. */
  | 'gate'
  /** A limit that aborts something (timeout, budget, cap). */
  | 'timeout'
  /** An in-code guard: a refusal, a validation, a precondition. */
  | 'guard'
  /** A background watcher: a probe, a supervisor, a sweep. */
  | 'watchdog'
  /** A named precondition holding a decision closed until evidence arrives. */
  | 'deferral-gate';

export interface Control {
  /** Stable kebab-case id. Unique across the registry. */
  id: string;
  kind: ControlKind;
  /**
   * The absence-class claim this control puts on the team record — what it asserts is being
   * prevented. Write it as the sentence someone would rely on.
   */
  claim: string;
  /** Where the control lives: file path, ADR, or service. */
  where: string;
  /**
   * How to fire it deliberately and watch it trip — concrete enough for a reader to run. "It's
   * covered by tests" is not an exercise; naming the test that makes it fail is.
   */
  exercise: string;
  /** The incident that motivated the control, with a date and a reference. */
  motivatedBy: string;
  /**
   * Would this control have caught the incident that motivated it? Answer honestly, including
   * "no" — a `no` is a finding, not a failure to hide. Required, and the gate rejects a stub.
   */
  counterfactual: string;
  /**
   * ISO date (YYYY-MM-DD) someone last ran this control and observed the result. Exactly one of
   * this and {@link neverExercised}.
   */
  lastExercised?: string;
  /**
   * Stated reason this control has never been deliberately exercised. Required rather than
   * optional so that absence is *declared*: an empty field used to mean both "never exercised" and
   * "nobody said", and a check cannot tell those apart (the ADR 177 lesson, applied here).
   */
  neverExercised?: string;
  /**
   * ISO date the declared absence STARTED (usually the day the control shipped). Required with
   * {@link neverExercised}, and stale-checked against {@link staleAfterDays} exactly like an
   * exercise date — so a declared absence acquires an expiry instead of being a permanent
   * exemption. Increment 1 lacked this, and izzo's acceptance named the hole precisely: a control
   * could sit unexercised forever while the gate stayed green and the ⚠ became wallpaper — the
   * registry's own thesis turned on itself (2026-08-20, msg 01M0GVQ36P).
   */
  neverExercisedSince?: string;
  /** Has this control ever actually caught something in the wild? */
  everTripped: boolean;
  /** ISO date of the most recent real trip. Required when {@link everTripped} is true. */
  lastTripped?: string;
  /**
   * Days after which the exercise evidence goes stale and the gate fails. Choose it from how fast
   * the thing underneath changes, not from a default — a control over a file edited weekly rots
   * faster than one over a shipped protocol.
   */
  staleAfterDays: number;
  /** PRs, ADRs, claims-ledger entries, lanes. */
  refs: string[];
}

export const CONTROLS: Control[] = [
  {
    id: 'adr-272-routing-deferral-gate',
    kind: 'deferral-gate',
    claim:
      'Role-addressed sends and the routing machinery (ADR 272 §5) stay unbuilt until ADR 227’s measured trigger fires — the role-filtered discovery→directed-send join firing repeatedly on real seats.',
    where: 'docs/decisions/272-*.md §5; the signal is the `roster.role_query` audit row',
    exercise:
      "Run ADR 227's eval SQL against the live audit table: `SELECT count(*) FROM audit WHERE action = 'roster.role_query'`, then join the hits to directed sends by the same actor within the window. Zero rows means the trigger has not fired; the gate holds. This is what #912 did.",
    motivatedBy:
      "2026-08-14: ADR 272's original scope (#851) cited this gate as satisfied and authorized the full registry + routing resolver. The gate had never fired. stanley's challenge (2026-08-19) forced the measurement and the ADR was narrowed in #917 — five days of a decision resting on an unmet precondition.",
    counterfactual:
      'Yes — and that is the sharp part. Running the query is exactly what caught it, five days late. The control was never broken; it was never RUN. That gap between "a gate exists" and "a gate fired" is the reason this registry records exercise dates rather than just listing guards.',
    lastExercised: '2026-08-19',
    everTripped: false,
    staleAfterDays: 120,
    refs: [
      'PR #912 (second measurement)',
      'PR #917 (ADR 272 revision)',
      'docs/claims/entries/2026-08-19-adr-272-routing-past-the-gate.md',
      'ADR 227 §Eval',
    ],
  },
  {
    id: 'vitest-package-timeout-parity',
    kind: 'timeout',
    claim:
      'Every vitest config in the repo runs at the same measured timeout, so a slow test fails the same way under `pnpm test` and `pnpm -r test`.',
    where: 'vitest.shared.ts (TEST_TIMEOUT_MS), imported by the root and all five package configs',
    exercise:
      'Edit any package `vitest.config.ts` to drop the shared import and set its own timeout; `tests/vitest-config-parity.test.ts` must fail. Independently: add a test that sleeps 6s and run it under a package config — at the 5s default it fails, at the shared ceiling it passes.',
    motivatedBy:
      'Measured 2026-08-19 (#918): the root\'s 30s ceiling reached zero of five packages because a package-local config inherits nothing. Presented for a week as "known flaky-test noise", it cost dolly a lane (01M06QZQDQ) and ryder most of a day. Baseline 2/20 full runs failed, all by timeout; with the fix 0/20.',
    counterfactual:
      'Yes, and it is the rare case where that was measured rather than argued: the parity test fails on the exact pre-fix configuration, and the 6s probe reproduces the original symptom under a package config. The control that DIDN\'T catch it was the wiki claim calling the failures noise — see the falsifier control below.',
    lastExercised: '2026-08-19',
    everTripped: true,
    lastTripped: '2026-08-19',
    staleAfterDays: 90,
    refs: [
      'PR #918',
      'vitest.shared.ts',
      'tests/vitest-config-parity.test.ts',
      'docs/claims/entries/2026-08-19-vitest-known-noise.md',
      'lane 01M0E4307G',
    ],
  },
  {
    id: 'wiki-falsifier-must-be-able-to-fail',
    kind: 'gate',
    claim:
      'A wiki claim carries a falsifier that can actually fail — one whose passing outcome is not also produced by the claim being wrong.',
    where: 'docs/wiki/README.md rule 3; enforced socially at review, checked in part by wiki:check',
    exercise:
      'Take a claim whose failure mode also satisfies its falsifier (the archetype: "intermittent failures are harmless noise", falsified by "re-run the file alone" — which passes for harmless noise AND for a real load-only defect) and confirm review rejects it.',
    motivatedBy:
      '2026-08-12→19: the wiki classified full-suite CLI failures as runner noise, dated and with a falsifier that could not fail. It stood seven days and stopped everyone looking; the real cause was the vitest timeout above (#918). Rule 3 was written from it in #925.',
    counterfactual:
      'Yes on the motivating claim — rule 3 rejects "re-run the file alone" directly, because the same observation follows from noise and from a load-only defect. Weaker in general: the rule is prose applied by a reviewer, not a script, so it depends on someone asking the question. That is a known gap, not a solved one.',
    lastExercised: '2026-08-20',
    everTripped: true,
    lastTripped: '2026-08-19',
    staleAfterDays: 90,
    refs: [
      'PR #925',
      'docs/wiki/README.md rule 3',
      'docs/claims/entries/2026-08-19-vitest-known-noise.md',
      'lane 01M0EA91V9',
    ],
  },
  {
    id: 'roadmap-frozenby-drift-watch',
    kind: 'gate',
    claim:
      "A roadmap item and its freezing ADR cannot silently disagree: shipped ⟹ the ADR is accepted, and not-shipped ⟹ it is not accepted (unless `building` states what remains).",
    where: 'scripts/check-roadmap-truth.ts rule 3; the anchor invariant is in content/roadmap.data.ts',
    exercise:
      'Flip any `frozenBy` ADR to accepted while leaving its item planned and without `building`, then run `pnpm roadmap-truth:check` — it must fail naming the item. Removing both `frozenBy` and `unfrozen` from an item must throw at import.',
    motivatedBy:
      'The check originally watched 11 of 82 items, because an absent anchor meant both "no ADR freezes this" and "nobody said" — and two of the items that had drifted were in the unwatched set. ADR 177 made the negative a stated value (`unfrozen`), which is what closed it.',
    counterfactual:
      'PARTLY — corrected 2026-08-20 from a "Yes" that overclaimed, by dolly’s mutation test during the #942 acceptance: flipping ADR 272 back to `proposed` does NOT fail the gate, because rule 3’s two enforcement branches fire only on `shipped` and `plan` items, and role-routing-profiles sits at `building`. She proved the gate does bite where it applies (flipping ADR 21 under the shipped driver-co-presence → exit 1). So: watched and enforced are different facts — a `building` item is anchored but not enforceable until it moves, and the headline "under drift watch" percentage counts items rule 3 cannot currently fail on. The residual `unfrozen` hole also stands: declared-but-unwatched by design.',
    lastExercised: '2026-08-20',
    everTripped: true,
    lastTripped: '2026-08-04',
    staleAfterDays: 120,
    refs: [
      'scripts/check-roadmap-truth.ts',
      'ADR 177',
      'lane 01KYNBYEW8 (frozenBy coverage)',
      'lane 01M0GRM42W (ADR 272 moved into the watched set)',
      'msg 01M0GWYAAY (dolly’s mutation test — the "partly" correction)',
    ],
  },
  {
    id: 'daemon-down-raise-carries-evidence',
    kind: 'watchdog',
    claim:
      'A guardian `daemon_down` raise says what the probe actually saw and which kind of down it is, so the raise is diagnosable after the fact.',
    where: 'the guardian probe path; ADR 232 service seats',
    exercise:
      'Force each failure mode against a probe pointed at a dead port, a hung endpoint, and a healthy-but-slow one; each must produce a distinguishable body naming what was observed. Before #923 all three collapsed to one string.',
    motivatedBy:
      '22 `daemon_down` raises with one distinct body between them, none diagnosable after the fact — the probe swallowed its own errors. Repaired in #923; the false-raise pattern is its own ledger entry.',
    counterfactual:
      'Partly. It would have made the 22 raises READABLE, which is what it claims, but it would not have prevented them — the raises were true-positive-shaped and wrong for a different reason (the daemon was slow inside a restart window, not down). The restart-window discrimination is a separate control that does not exist yet, and this entry should not be read as covering it.',
    lastExercised: '2026-08-19',
    everTripped: true,
    lastTripped: '2026-08-19',
    staleAfterDays: 60,
    refs: [
      'PR #923',
      'docs/claims/entries/2026-08-19-guardian-daemon-down.md',
      'lane 01M0E9MRDJ',
    ],
  },
  {
    id: 'adr-227-infra-touch-gate',
    kind: 'guard',
    claim:
      'A seat touching shared infrastructure without holding the `platform` role gets warned, and the touch leaves an `infra.touch.warned` audit row.',
    where:
      'GET /teams/:slug/infra-gate, wired into `service install|restart|refresh`, `reset`, AND `musterd agent` (agent.ts:90, lane 01KZ9JSX10 — the verb that rewrites the machine-shared MCP entry, the most consequential of the touches; increment 1 omitted it, and izzo’s acceptance flagged the understatement as the same defect class as a stale date)',
    exercise:
      'From a seat that does not hold `platform`, run `musterd service restart` AND `musterd agent` against a team with a platform holder; expect the warning on stderr and one `infra.touch.warned` row per touch in the audit table. Exercising only the `service` verbs is not coverage — `agent` is the biggest surface. The CLI half is a silence contract, so also confirm an unreachable daemon produces nothing rather than stalling the verb.',
    motivatedBy:
      'ADR 227 increment 2 (2026-08-04): any agent could restart or rebuild shared infrastructure while teammates depended on it, with no signal to anyone.',
    counterfactual:
      'Unknown, and that is the finding. The gate is warn-only by design, so "catching" means emitting a warning someone reads — and no measurement exists of whether any warning has ever been read or changed a behaviour. Registering it with `neverExercised` is the honest state; the ADR 227 hardening ramp (warn → --force → refuse) is explicitly gated on a measured warn→redirect rate that has never been measured.',
    neverExercised:
      'No deliberate exercise is recorded since it shipped 2026-08-04. The audit row is written by the daemon, but nothing reads the row count, and no seat has fired the gate on purpose to confirm it still warns. izzo (the gate’s owner) committed on 2026-08-20 to firing it and reading the rows — when that lands, this entry flips to a dated exercise and produces the warn→redirect denominator the ADR 227 hardening ramp has been gated on unmeasured.',
    neverExercisedSince: '2026-08-04',
    everTripped: false,
    staleAfterDays: 60,
    refs: ['ADR 227 increment 2', 'PR #654', 'lane 01KZ9JSX10 (the `agent` wiring)'],
  },
  {
    id: 'stale-dist-typecheck-guard',
    kind: 'guard',
    claim:
      'Typecheck refuses to run against build output older than its source, so a green typecheck cannot come from a stale `dist/`.',
    where: 'scripts/check-dist-freshness.ts, run ahead of `pnpm typecheck`',
    exercise:
      'Edit any file under `packages/*/src` without rebuilding and run `pnpm typecheck`: it must refuse, naming each package whose source is newer than its build, rather than reporting a result.',
    motivatedBy:
      'Five recurrences on 2026-08-13/14: a stale dist made typecheck report failures that belonged to nobody’s change, sending seats to blame a teammate’s merged PR (docs/wiki/running-the-gates.md).',
    counterfactual:
      'Yes — it reproduces the motivating condition exactly, because the condition IS "source newer than build" and that is the predicate it tests. It is one of the few controls here whose falsifier and whose failure mode are the same observable.',
    lastExercised: '2026-08-20',
    everTripped: true,
    lastTripped: '2026-08-20',
    staleAfterDays: 120,
    refs: [
      'scripts/check-dist-freshness.ts',
      'scripts/check-dist-freshness.test.ts',
      'docs/wiki/running-the-gates.md',
    ],
  },
  {
    id: 'change-adr-decision-immutability',
    kind: 'gate',
    claim:
      'An accepted ADR’s `## Decision` section cannot be edited in place — supersession or a dated Consequences note is the only path — and protocol-schema or new-runtime-dependency changes cannot land without an ADR in the same change.',
    where: 'scripts/check-change-adr.ts (`pnpm change-adr:check`, CI ci.yml — diff-based, judged at the merge-base)',
    exercise:
      'Edit any accepted ADR’s `## Decision` on a branch and run `pnpm change-adr:check` — it must fail naming the file and the supersession path. dolly did exactly this by accident on 2026-08-20 (#946’s ADR 290 amendment), and the gate named the fix: amendments go in Consequences as a dated note.',
    motivatedBy:
      '2026-08-05: the status matcher’s `\\s*$` anchor silently disabled rule 3 for 94 of 223 accepted ADRs — the ones with annotated status lines, which is the house style — and PR #733 rewrote ADR 131’s frozen `## Decision` with CI green. The full history is the header of scripts/adr-status.test.ts.',
    counterfactual:
      'NO at first, and that is the registered lesson: the gate existed when #733 landed and did not fire, because the matcher exempted exactly the annotated-status ADRs that included the motivating case. After the matcher fix it is a yes with live evidence rather than argument — 2026-08-20, the gate caught dolly editing accepted ADR 290’s Decision and she reported the trip to the team unprompted (msg 01M0GVXW6Q). A control whose counterfactual moved from no to yes is what exercising looks like over time.',
    lastExercised: '2026-08-20',
    everTripped: true,
    lastTripped: '2026-08-20',
    staleAfterDays: 120,
    refs: [
      'scripts/check-change-adr.ts',
      'scripts/adr-status.test.ts (the 2026-08-05 matcher hole)',
      'PR #733 (the miss)',
      'msg 01M0GVXW6Q (the live trip, dolly, 2026-08-20)',
    ],
  },
  {
    id: 'control-registry-liveness',
    kind: 'gate',
    claim:
      'Every control in this registry carries exercise evidence within its own staleness bound, or a stated-and-dated reason it has never been exercised whose age is checked against the same bound — so a guard cannot quietly become a guard nobody has watched work, and a declared absence cannot become a permanent exemption (the increment-1 hole izzo’s acceptance found).',
    where: 'scripts/check-controls.ts, wired into `pnpm format:check`',
    exercise:
      'Backdate any `lastExercised` past its `staleAfterDays` and run `pnpm controls:check`: it must name the control and exit 1. Each of the five rules also has a failing case in scripts/controls.test.ts.',
    motivatedBy:
      'The registry is itself an absence-class claim — "these guards are in force" — and would otherwise be the one control exempt from the discipline it imposes. A list that nobody checks rots exactly the way the guards it lists do.',
    counterfactual:
      'Yes for staleness and stated absence, verified end-to-end on 2026-08-20 rather than asserted: backdating the ADR 272 gate produced "last exercised 596d ago, past its own 120d staleness bound" and exit 1. It would NOT have caught the four motivating incidents directly — none of those controls was registered at the time — so its claim is narrow: it keeps the registry honest, it does not find new controls. Auto-discovery of unregistered guards is the obvious next increment and does not exist.',
    lastExercised: '2026-08-20',
    everTripped: true,
    lastTripped: '2026-08-20',
    staleAfterDays: 180,
    refs: ['scripts/check-controls.ts', 'scripts/controls.test.ts', 'lane 01M0ER0A0B'],
  },
];
