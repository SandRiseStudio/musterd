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
  /**
   * The watch measuring this control's rate, when a date cannot settle its efficacy (ADR 297).
   *
   * {@link Control.lastExercised} answers "did someone watch it work" — a moment. Some controls'
   * efficacy is a RATE, and a rate needs a window: ADR 227's infra-touch gate is the live instance,
   * where the warn→redirect rate was "unmeasurable as built" (lane `01M0GX9VD7`).
   *
   * Optional, and unset for every control whose efficacy a date does settle. Present with no
   * consumer yet on purpose — it is the join point, and leaving it out means the next person hits
   * the same wall ADR 227 did.
   */
  watch?: string;
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
    id: 'guardian-confirms-slow-before-down',
    kind: 'watchdog',
    claim:
      'Before the guardian calls a daemon down, it has tested the rival hypothesis — that the daemon is merely slow — with a probe on a DIFFERENT bound, and the raise reports what that probe found instead of asking a human to go and check.',
    where:
      'packages/cli/src/guardian/signals.ts (`collectSignals`, CONFIRM_TIMEOUT_MS) and the two `daemon_down` evidence branches in classify.ts',
    exercise:
      'Three fixtures, and the third is the one that matters. (1) SLOW: short probes reject, `confirmHealth` resolves → `health` is non-null and NO incident is produced. (2) WEDGED: both reject → still `daemon_down`, with `confirmMs` and `confirmError` in the evidence. (3) REFUSED: both reject with ECONNREFUSED → still down, and `confirmHealth` was called exactly once, so a real outage pays one fast-failing probe and no delay. Exercising only (1) is NOT coverage — a confirmation that cannot fail is a blindfold, and (2) is the test that it can. Also assert the collector, not the caller, names the bound (`askedFor === CONFIRM_TIMEOUT_MS`): if the caller chose it, a wiring that quietly passed the short bound would still emit evidence claiming the long one, and the raise would assert a discrimination that never happened. All in signals.test.ts / classify.test.ts.',
    motivatedBy:
      'Six false `daemon_down` alarms on 2026-08-21, the sixth arriving AFTER the #987 repeat damper shipped — which is what proved the two are different defects. ADR 274 confirms an unreachable /health with two further probes, but all three share one 2 s bound (`rawHealth`, service.ts), so inside a stall longer than that ~8 s window they are one observation repeated. Measured the same day on the live daemon: 25 samples under load gave p50 2.8 ms, p90 16 ms, max 3.22 s, while 90 samples taken quiet gave max 0.02 s — exceeding 2000 ms is normal operation, not pathology.',
    counterfactual:
      'Yes for the motivating incident, with a caveat I cannot close retroactively. All six raises were the clean-exit + timeout shape against a daemon whose booted_at never moved, and observed worst-case latency was 3.22 s against this probe\'s 10 s bound — so the confirm would almost certainly have answered and produced no incident at all. "Almost certainly" is the honest word: those moments cannot be re-run, and a stall longer than 10 s would still have raised. That residual is deliberate rather than a gap — a confirmation that cannot come out "down" would be a blindfold, and the wedged-daemon fixture exists to prove this one can.',
    lastExercised: '2026-08-21',
    everTripped: false,
    staleAfterDays: 60,
    refs: [
      'lane 01M0K31X42X62KBN504M0VAWP9',
      'ADR 274 (the three-probe confirmation this extends; its Decision is a floor, not a ceiling)',
      'control guardian-raise-damped-on-reason (removed the repeats; this one goes after the false positives)',
      'control daemon-down-raise-carries-evidence (made a raise readable; neither of those made it true)',
      'docs/claims/entries/2026-08-19-guardian-daemon-down.md',
    ],
    watch:
      'A date cannot settle this one either: the number to watch is `daemon_down` raises per week that a later /health read shows were false. Zero raises is not evidence the discrimination works — it is equally consistent with a quiet platform. The signal is the RATIO of raises that survive adjudication, and it needs a window.',
  },
  {
    id: 'guardian-raise-damped-on-reason',
    kind: 'guard',
    claim:
      'The guardian says a given raise once per hour at most, and repeats it only when its reason changes — and every repeat it withholds is counted and carried on the next raise that fires, so suppression never reads as recovery.',
    where: 'packages/cli/src/guardian/act.ts (`raise`) over damp.ts `shouldRaise`/`recordSuppressed`',
    exercise:
      'Drive `actOn` three times with one unchanged reason and assert one ask, two `guardian.suppressed` audits, and `lastRaise.<class>.suppressed === 2`; then change the evidence string and assert the next raise fires immediately. Both directions matter — a damper only exercised in the silencing direction is indistinguishable from a broken probe. The regression fixture is the real 2026-08-21 cluster (five byte-identical bodies at 12:18:10, 12:20:39, 12:23:02, 12:41:55, 12:51:14): `the 2026-08-21 cluster raises ONCE, not five times` in act.test.ts. Also exercise the exemption — two `service install --guardian` runs inside the hour must both print `control probe: alert path fired ✓`, because a dry run that silences the next dry run manufactures the false silence the damper exists to prevent.',
    motivatedBy:
      'The alert tier had no damper at all: `shouldAttempt` was consulted only inside the `tier === \'auto\' && remedy !== null` branch, so a class shipping as `alert` — which `daemon_down` does — raised on every tick that classified it. 30 guardian asks all-time carrying 4 distinct bodies; five byte-identical inside 33 minutes on 2026-08-21, all cleared as a false alarm. Nothing counted them as a series, which is ADR 250\'s "repeat wakes with an unchanged failure reason" instrument observed live on the ask path.',
    counterfactual:
      'Partly, and the boundary is the point. It would have collapsed the 2026-08-21 five into one and made the series countable — that is what it claims. It would NOT have stopped the first raise of each reason, so of the 30 raises it removes the repeats and not the false positives: the raises were true-positive-shaped and wrong because the daemon was slow inside a restart window, not down. That discrimination is a different control, still absent, and this entry must not be read as covering it — the same boundary its sibling `daemon-down-raise-carries-evidence` draws, one step further along. Read the two together: #923 made a raise diagnosable, this makes it non-repeating, and neither makes it true.',
    lastExercised: '2026-08-21',
    everTripped: false,
    staleAfterDays: 60,
    refs: [
      'lane 01M0K1TYNPFQ9TJYR9GQS2ED4T',
      'ADR 250 §Observability (the instrument this closes on the ask path)',
      'docs/claims/entries/2026-08-19-guardian-daemon-down.md',
      'docs/wiki/platform-guardian.md',
      'control daemon-down-raise-carries-evidence (the sibling half)',
    ],
    watch:
      'Efficacy here is a rate, not a moment: `guardian.suppressed` lines per `guardian.alerted` line in ~/.musterd/guardian/guardian.log. Zero suppressions over a window where raises fired means either a genuinely quiet platform or a damper that is not engaging, and a date cannot tell those apart.',
  },
  {
    id: 'adr-227-infra-touch-gate',
    kind: 'guard',
    claim:
      'A seat touching shared infrastructure without holding the `platform` role gets warned, and the touch leaves an `infra.touch.warned` audit row.',
    where:
      'GET /teams/:slug/infra-gate, wired into `service install|restart|refresh`, `reset`, AND `musterd agent` (agent.ts:90, lane 01KZ9JSX10 — the verb that rewrites the machine-shared MCP entry, the most consequential of the touches; increment 1 omitted it, and izzo’s acceptance flagged the understatement as the same defect class as a stale date)',
    exercise:
      'DO NOT run the destructive verb. The control is `GET /teams/:slug/infra-gate?verb=<verb>` and has no infra side effect — `service restart` is what FOLLOWS the warning, and running it bounces the daemon under every live teammate. Fire the GET directly, with `?verb=agent` as well as a `service` verb: expect the warning text and one `infra.touch.warned` row per call. Exercising only the `service` verbs is not coverage — `agent` is the biggest surface. Also confirm the CLI half\'s silence contract: an unreachable daemon returns null fast rather than stalling the verb (`infraTouchWarning` against a dead port). ROSTER PRECONDITION: the warn branch is only reachable from a seat that does NOT hold `platform`; a holder gets `{"warn":null}` and no audit row BY DESIGN, so from a holder\'s seat the warning cannot be fired at all and the end-to-end warn path has to be driven against a daemon booted for the purpose. Say which branch you fired where. (2026-08-05 stanley and 2026-08-21 izzo both reached this conclusion independently and left the daemon alone; docs/wiki/controls-in-force.md#what-an-exercise-looks-like has the worked example.)',
    motivatedBy:
      'ADR 227 increment 2 (2026-08-04): any agent could restart or rebuild shared infrastructure while teammates depended on it, with no signal to anyone.',
    counterfactual:
      'The gate does what it claims — it warns, and the row lands. What it CANNOT support is the decision resting on it. ADR 227’s hardening ramp (warn → --force → refuse) is gated on a measured warn→redirect rate, and no redirect signal exists: `result` is always `allow`, the touch always proceeds, and a COMPLETED infra touch writes no row at all, so there is neither a numerator (did this seat back off?) nor a denominator of total touches — only of warned ones. The obvious proxy is worse than absent: "warned, then raised an ask within 30 minutes" scores ryder’s 2026-08-05 touch as a redirect, when their ask in that window was an unrelated lane acceptance and they proceeded with the bounce under nick’s explicit instruction. Of the three rows to date, two are real warned touches and both were correctly proceeded with, so redirects = 0 of 2 — a rate no hardening could honestly rest on. Measured 2026-08-21, lane 01M0GX9VD7.',
    lastExercised: '2026-08-21',
    everTripped: true,
    /**
     * ryder, 2026-08-05 22:48:31 and 22:49:00 (`verb=refresh`), warned and proceeded — twenty-five
     * seconds later: "Bouncing the daemon in ~30s, ~5s of downtime — nick asked me to force it."
     * The bounce is corroborated in the audit table rather than taken on the message's word: at
     * 22:49:13 every live seat re-claims (claim.occupied + occupancy.model_attested for ryder, kimi,
     * izzo, and two web seats), which is the restart signature. A real touch, warned, and correctly
     * overridden by human authority — the warn-only design working, not failing.
     *
     * The third row (stanley, 19:31:02, `verb=agent`) is NOT a trip: they fired the endpoint
     * deliberately while accepting #689 and explicitly declined to run the verb for real. One audit
     * row shape covers both an exercise and a trip, which is worth knowing about the instrument —
     * the two facts this schema separates are not separable from the row alone.
     */
    lastTripped: '2026-08-05',
    staleAfterDays: 60,
    refs: [
      'ADR 227 increment 2',
      'PR #654',
      'lane 01KZ9JSX10 (the `agent` wiring)',
      'lane 01M0GX9VD7 (the exercise)',
      'docs/claims/entries/2026-08-21-infra-gate-never-exercised.md',
    ],
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
  {
    id: 'adr-296-terminology-gate',
    kind: 'gate',
    claim:
      'After ADR 296, zero banned terminology synonyms (profile / kit / template / worktree) are introduced in new ADRs or new user-facing files, brand.md §5 cannot silently drop a canonical term, and the grandfather baselines cannot hold entries for deleted files — the burn-down count the eval measures against only counts work that exists.',
    where:
      'scripts/check-vocab.ts (terminology table + glossaryDrift + baselineRot); docs/glossary/terms.ts',
    exercise:
      'Add an unbackticked "profile" to a new ADR numbered ≥ 299 (or a new file under packages/cli/src/help/) and run `pnpm vocab:check` — it must fail naming the file. `scripts/check-vocab.test.ts` is that case. Independently: delete **Toolkit** from brand.md §5 and the same command must fail on glossary drift. Third: add a nonexistent path to USER_FACING_BASELINE and the same command must fail naming the dead exemption (the 2026-08-21 rot, reconstructed in the test).',
    motivatedBy:
      '2026-08-21 design conversation: the team admin asked "aren\'t those profiles just roles?" — ADR 272 had already drawn the line, but the glossary was still prose, so the question was unanswerable from brand.md §5.',
    counterfactual:
      'Yes for new introductions of the lintable synonyms (profile/kit/template/worktree) — the fixture fails on the exact word. No for the semantic half of the Not column (agent-as-generic-noun, surface-as-lane-paths): a regex cannot catch those, and claiming it would is the decoration this registry exists to refuse. Those stay a review job against the regenerated glossary.',
    lastExercised: '2026-08-24',
    // ADR 299 (#972) landed minutes before the gate (#973) with an unquoted "worktree" in its
    // frozen Decision — the gate turned main red on its first day; #978 moved the boundary to 300
    // rather than editing a frozen ADR. A real catch, in anger. Full eval record:
    // docs/wiki/adr-296-terminology-eval.md.
    everTripped: true,
    lastTripped: '2026-08-21',
    staleAfterDays: 45,
    refs: [
      'ADR 296',
      'scripts/check-vocab.ts',
      'scripts/check-vocab.test.ts',
      'docs/glossary/terms.ts',
      'docs/wiki/adr-296-terminology-eval.md',
      'lane 01M0JT3RTC',
      'lane 01M0K5YCCQ',
      'lane 01M0K5ZPRJ',
    ],
  },
  {
    id: 'context-budget-coherence',
    kind: 'gate',
    claim:
      'The standing-context budget set is internally satisfiable: no composite budget (perTurnTotalBytes, perSessionTotalBytes) may sit below the sum of its components’ budgets, so obeying every line item can never fail the headline.',
    where: 'scripts/context/budgetCoherence.ts, called from scripts/context/check-budgets.ts (`pnpm context:check`, wired into CI)',
    exercise:
      'Lower `perTurnTotalBytes` in docs/perf/context-budgets.json below the sum of toolsListDefaultBytes + promptSubmitNudgeBytes + labelNudgeBytes and run `pnpm context:check`: it must fail naming the shortfall and both repairs. `scripts/context/budgetCoherence.test.ts` reconstructs the real 2026-08-20 violation and asserts "short by 795".',
    motivatedBy:
      '2026-08-20: perTurnTotalBytes sat 795 B below the sum of its parts (and perSessionTotalBytes 2 B below its own) after the components were re-baselined on 2026-08-19 while the composites kept an older baseline. The per-turn headroom was down to 7 B, so the next word added to any MCP tool description would have failed a gate that was already unsatisfiable — and the failure text said "trim it, or raise the budget", which could not work. dolly flagged the trap on #941; nick called it.',
    counterfactual:
      'Yes. Run against the file as committed on 2026-08-19 it fails immediately — the contradiction was created that day, and this rule reads budgets rather than measurements precisely so it fires when the file is written rather than months later when something finally grows into it. Worth naming the limit too: it proves the set is SATISFIABLE, not that the ceiling is small enough. Only a human raising perTurnTotalBytes decides that, which is now a single deliberate act instead of a side effect of re-baselining a part.',
    lastExercised: '2026-08-20',
    everTripped: true,
    lastTripped: '2026-08-20',
    staleAfterDays: 180,
    refs: [
      'scripts/context/budgetCoherence.ts',
      'scripts/context/budgetCoherence.test.ts',
      'docs/perf/context-budgets.json',
      'lane 01M0GXCJDJ',
    ],
  },
  {
    id: 'lane-submit-refuses-unlanded',
    kind: 'guard',
    claim:
      'A lane cannot enter awaiting_acceptance claiming an artifact that has not landed: lane_submit verifies the attested SHA against origin/main seat-side and refuses a PR-without-SHA or a not-ancestor SHA (ADR 300 — awaiting_acceptance means landed).',
    where: 'packages/mcp/src/tools/lanes.ts (laneSubmitHandler) + packages/mcp/src/mergeVerify.ts; ADR 300',
    exercise:
      "From a seat worktree with unmerged commits: `node -e` verifyMerge({sha: <HEAD>, cwd}) from the built dist — must return 'not_ancestor' (and 'ancestor' for a landed SHA). Or lane_submit a scratch lane with pr and no sha — refused with 'arm auto-merge'. mergeVerify.integration.test.ts runs the same tiers against a real bare-remote repo.",
    motivatedBy:
      "2026-08-21: dolly's #961/#963 sat awaiting_acceptance with green unmerged PRs (auto-merge never armed). wanderer spent two check cycles holding for lanes with nothing to accept; the false 'landed' claim propagated into ryder's wiki page and cost a second seat a lane (#967). Lane 01M0JSKTA3.",
    counterfactual:
      "Yes — dolly submitted with a PR number and no landed SHA (none existed; the PRs were open). The pr-without-sha refusal fires on exactly that call, and the refusal text reaches the one seat that owns the missing act, at the moment it acts.",
    lastExercised: '2026-08-21',
    everTripped: false,
    staleAfterDays: 90,
    refs: [
      'ADR 300',
      'lane 01M0JSKTA3YH2CTHD869X1YWCZ',
      'docs/superpowers/specs/2026-08-21-merge-verified-submit-design.md',
      'packages/mcp/src/mergeVerify.integration.test.ts',
    ],
  },
];
