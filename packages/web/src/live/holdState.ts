import type { AskView } from './asks';

/**
 * The asks rail's consequence line: what happens next, in words a stranger owns.
 *
 * The strip used to render the tier as a bare token — `blocking`, `standard`, `advisory`. That is
 * the protocol's word for the contract, and it tells a stranger nothing about what the ask will DO
 * if nobody answers, which is the only thing they need. ADR 320 §5 puts "the record holds what the
 * harness observed" in front of every stranger; the same obligation applies here — a hold state the
 * product asserts has to be readable ON the product.
 *
 * Copy is docs/design/attestation-copy-spec.md §4, character for character, and the tests pin it.
 *
 * TWO RULES THE STRINGS ENCODE, worth knowing before editing one:
 *   - A hold is a fact about the ASKER, never a status of the human. "waiting on nick" and
 *     "stanley is holding" — never "pending approval", never "blocked on nick". The human is a
 *     member, not a supervisor (PRODUCT.md), and the words have to carry that or the copy is the
 *     only place it is true.
 *   - The tier token stays in the tooltip. It is precise and it is ours; a member who knows the
 *     contract can still read it on hover, and a stranger is never shown a word that needs a
 *     glossary to mean anything.
 *
 * Returns `null` for the settled verdicts (accepted / declined / resolved / deferred) — those
 * already render their own outcome and this line would only repeat it.
 */
export function holdStateLine(
  ask: AskView,
  now: number,
): { line: string; title: string } | null {
  // `to` is null for a team or broadcast ask: it is addressed to the roster, not to a person. The
  // spec's word is "anyone" — never "the human", which would name a category rather than a member.
  const name = ask.to ?? 'anyone';
  const asker = ask.env.from;

  switch (ask.state) {
    case 'open':
      return ask.tier === 'blocking'
        ? {
            line: `waiting on ${name} · holds until answered`,
            title:
              'Blocking. The asker pauses and keeps re-notifying. It will not go ahead without an answer.',
          }
        : {
            line: `waiting on ${name} · goes ahead in ${remaining(ask.deadline, now)} if unanswered`,
            title:
              ask.tier === 'advisory'
                ? 'Advisory. Same as standard, shorter window.'
                : 'Standard. If nobody answers in the window, the asker proceeds and records that it proceeded without an answer.',
          };
    case 'held':
      return {
        line: `${name} has not answered · ${asker} is holding`,
        title:
          'The window ran out on a blocking ask. The asker is paused and re-notifying; nothing proceeded.',
      };
    case 'risk_accepted':
      return {
        line: `${asker} went ahead without ${name}`,
        title:
          'The window ran out. The asker proceeded and wrote down that it did so without an answer.',
      };
    case 'stranded':
      return {
        line: `nobody home to answer · ${asker} is holding`,
        title: 'A blocking ask with no reachable answerer. Held, not proceeded (ADR 153).',
      };
    case 'lapsed':
      return {
        line: `went unanswered · ${asker} went ahead`,
        title:
          'Below the top tier, out of window, nobody home. Proceeded with the risk recorded.',
      };
    default:
      return null;
  }
}

/**
 * Minutes left, or the honest words when there are none.
 *
 * `0m` is the reading this avoids: it is wrong for the ~59 seconds it covers, and it is wrong in
 * the direction that matters — a reader told "goes ahead in 0m" concludes it already went.
 */
function remaining(deadline: number, now: number): string {
  const ms = deadline - now;
  if (ms < 60_000) return 'under a minute';
  return `${Math.floor(ms / 60_000)}m`;
}
