/*
 * Control liveness check — the registry of controls cannot silently rot.
 *
 * `docs/controls/registry.ts` is a curated *declaration* that certain guards are in force. This
 * check verifies the declaration against the one thing that makes it more than a list: whether
 * anyone has recently watched each control work. It is the same move as check-roadmap-truth
 * (a declaration anchored to a signal outside itself) applied to guards instead of shipped-ness.
 *
 * The rules, and why each is an error rather than a warning:
 *
 *   1. exercised-xor-never   — a control states either a `lastExercised` date or a reason it has
 *      never been exercised. An empty field would mean both "never" and "nobody said", and a check
 *      cannot tell those apart — the ADR 177 lesson that took the roadmap's drift watch from 11 of
 *      82 items to 67 of 85. A `neverExercised` reason also carries `neverExercisedSince` (when
 *      the absence started) — increment 2, from izzo's acceptance finding.
 *   2. dates are real        — ISO YYYY-MM-DD, a valid calendar date, not in the future. A future
 *      date would push a control permanently out of staleness.
 *   3. tripped ⟹ dated       — `everTripped: true` needs `lastTripped`. "It has caught things"
 *      without a date is the exact unfalsifiable shape this registry exists to stop.
 *   4. counterfactual answered — the "would this have caught its own motivating incident?" field is
 *      present and substantive. A `no` passes; a stub does not. The question is the point.
 *   5. not stale             — `lastExercised` within the control's own `staleAfterDays`.
 *
 * Rule 5 is deliberately allowed to break the build on a date rollover with no code change. That is
 * uncomfortable and it is the design: a liveness check that cannot fail on its own is precisely the
 * disease (wiki rule 3 — a falsifier that its own failure mode also satisfies is not a falsifier).
 * The pressure valve is honest, not silent — re-exercise the control and move the date, or widen
 * `staleAfterDays` with a reason in the PR. Both leave a record; ignoring it does not.
 *
 * A `neverExercised` control IS stale-checked as of increment 2 — its `neverExercisedSince` date
 * ages against the same bound as an exercise date would. Increment 1 skipped it ("no date to
 * age"), which made the reason a permanent exemption: izzo's acceptance named that as the
 * registry's own thesis turned on itself, and he was the one entry living in the hole when he
 * named it. Now a declared absence expires; it is also still printed on every run.
 *
 *   pnpm controls:check
 */
import { CONTROLS, type Control } from '../docs/controls/registry.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True iff `s` is a real calendar date in YYYY-MM-DD (rejects 2026-02-31, which Date accepts). */
function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function daysBetween(fromIso: string, to: Date): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  return Math.floor((to.getTime() - from) / 86_400_000);
}

/**
 * Validate the registry. Exported (with an injectable `now`) so the tests can prove each rule
 * actually fails — a check whose failure path is never executed is itself an unexercised control,
 * and shipping one from this file would be absurd.
 */
export function checkControls(controls: Control[], now: Date): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const c of controls) {
    const at = (msg: string) => errors.push(`"${c.id}": ${msg}`);

    if (seen.has(c.id)) at('duplicate id — control ids must be unique.');
    seen.add(c.id);

    // (1) exercised-xor-never
    const hasDate = c.lastExercised !== undefined;
    const hasReason = c.neverExercised !== undefined;
    if (hasDate === hasReason) {
      at(
        'must declare exactly one of `lastExercised` (a date someone watched it work) or ' +
          '`neverExercised` (a stated reason nobody has). An absent value would mean both.',
      );
      continue;
    }
    if (hasReason && c.neverExercised!.trim().length < 20) {
      at('`neverExercised` must state a real reason, not a placeholder.');
    }
    // (1b) a declared absence carries its start date — without one, `neverExercised` is a
    // PERMANENT staleness exemption, which is the registry's own thesis turned on itself
    // (izzo's increment-1 acceptance finding, 2026-08-20).
    if (hasReason && c.neverExercisedSince === undefined) {
      at(
        '`neverExercised` needs `neverExercisedSince` (when the absence started) — an undated ' +
          'absence never expires, and a permanent exemption is the exact rot this registry exists to stop.',
      );
    }
    if (!hasReason && c.neverExercisedSince !== undefined) {
      at('has `neverExercisedSince` but no `neverExercised` reason — they travel together.');
    }

    // (2) dates are real, and not in the future
    const today = now.toISOString().slice(0, 10);
    for (const [field, value] of [
      ['lastExercised', c.lastExercised],
      ['lastTripped', c.lastTripped],
      ['neverExercisedSince', c.neverExercisedSince],
    ] as const) {
      if (value === undefined) continue;
      if (!isRealDate(value)) {
        at(`\`${field}\` must be a real ISO date (YYYY-MM-DD); got "${value}".`);
      } else if (value > today) {
        at(
          `\`${field}\` is in the future ("${value}") — a control cannot have been exercised yet.`,
        );
      }
    }

    // (3) tripped ⟹ dated
    if (c.everTripped && c.lastTripped === undefined) {
      at('`everTripped` is true but no `lastTripped` date — an undated catch is unverifiable.');
    }
    if (!c.everTripped && c.lastTripped !== undefined) {
      at('has a `lastTripped` date but `everTripped` is false — they disagree.');
    }

    // (4) the counterfactual is answered
    if (c.counterfactual.trim().length < 40) {
      at(
        'must answer `counterfactual` — would this control have caught the incident that ' +
          'motivated it? "No" is a valid and useful answer; a stub is not.',
      );
    }

    // (5) not stale — an exercise date ages, and so does a declared absence: `neverExercisedSince`
    // is checked against the SAME bound, so "nobody has ever fired this" stops being a free pass
    // once the control is old enough that someone should have.
    if (c.staleAfterDays <= 0) {
      at('`staleAfterDays` must be positive.');
    } else if (c.lastExercised !== undefined && isRealDate(c.lastExercised)) {
      const age = daysBetween(c.lastExercised, now);
      if (age > c.staleAfterDays) {
        at(
          `last exercised ${age}d ago, past its own ${c.staleAfterDays}d staleness bound. ` +
            'Exercise it and move the date, or widen the bound with a reason — but do not leave ' +
            'the claim standing on evidence this old.',
        );
      }
    } else if (c.neverExercisedSince !== undefined && isRealDate(c.neverExercisedSince)) {
      const age = daysBetween(c.neverExercisedSince, now);
      if (age > c.staleAfterDays) {
        at(
          `never exercised in the ${age}d since it shipped — past its own ${c.staleAfterDays}d ` +
            'bound. The declared absence has expired: fire the control deliberately and record ' +
            'what you saw, or retire the entry. It does not get older quietly.',
        );
      }
    }
  }
  return errors;
}

/* c8 ignore start — entrypoint; the logic above is what the tests drive. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = checkControls(CONTROLS, new Date());
  const never = CONTROLS.filter((c) => c.neverExercised !== undefined);
  const untripped = CONTROLS.filter((c) => !c.everTripped);

  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`✗ ${e}\n`);
    process.stderr.write(
      '\nA control in the registry is making a claim its evidence no longer supports. ' +
        'See docs/controls/registry.ts and scripts/check-controls.ts.\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    `✓ controls: ${CONTROLS.length} registered, all exercise evidence current — ` +
      `${never.length} never exercised, ${untripped.length} never tripped\n`,
  );
  // Never-exercised controls are legal but must not go quiet: they are the registry's whole point.
  // The countdown is printed so the expiry is visible before it fails the build.
  for (const c of never) {
    const left =
      c.neverExercisedSince !== undefined
        ? ` (${c.staleAfterDays - Math.floor((Date.now() - new Date(`${c.neverExercisedSince}T00:00:00Z`).getTime()) / 86_400_000)}d until this expires)`
        : '';
    process.stdout.write(`  ⚠ ${c.id} — never exercised${left}: ${c.neverExercised}\n`);
  }
}
/* c8 ignore stop */
