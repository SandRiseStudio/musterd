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
 *      82 items to 67 of 85.
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
 * A `neverExercised` control is NOT stale-checked — there is no date to age. It is counted and
 * printed on every run instead, so it stays visible rather than becoming a permanent free pass.
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

    // (2) dates are real, and not in the future
    const today = now.toISOString().slice(0, 10);
    for (const [field, value] of [
      ['lastExercised', c.lastExercised],
      ['lastTripped', c.lastTripped],
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

    // (5) not stale
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
  for (const c of never) {
    process.stdout.write(`  ⚠ ${c.id} — never exercised: ${c.neverExercised}\n`);
  }
}
/* c8 ignore stop */
