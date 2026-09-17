import { describe, expect, it } from 'vitest';
import { holdStateLine } from './holdState';
import type { AskView } from './asks';

const MIN = 60_000;
const NOW = 1_700_000_000_000;

function ask(over: Partial<AskView> & { from?: string } = {}): AskView {
  const { from = 'stanley', ...rest } = over;
  return {
    env: { id: 'e1', from, body: 'why' } as AskView['env'],
    species: 'approve',
    tier: 'standard',
    to: 'nick',
    deadline: NOW + 5 * MIN,
    state: 'open',
    ...rest,
  } as AskView;
}

describe('holdStateLine — the consequence, not the tier token', () => {
  it('blocking says it holds, and never names a window', () => {
    const r = holdStateLine(ask({ tier: 'blocking' }), NOW);
    expect(r?.line).toBe('waiting on nick · holds until answered');
    expect(r?.title).toBe(
      'Blocking. The asker pauses and keeps re-notifying. It will not go ahead without an answer.',
    );
  });

  it('standard names the window and what happens when it runs out', () => {
    const r = holdStateLine(ask({ tier: 'standard' }), NOW);
    expect(r?.line).toBe('waiting on nick · goes ahead in 5m if unanswered');
    expect(r?.title).toBe(
      'Standard. If nobody answers in the window, the asker proceeds and records that it proceeded without an answer.',
    );
  });

  it('advisory reads the same to a stranger and differs only in the tooltip', () => {
    const r = holdStateLine(ask({ tier: 'advisory' }), NOW);
    expect(r?.line).toBe('waiting on nick · goes ahead in 5m if unanswered');
    expect(r?.title).toBe('Advisory. Same as standard, shorter window.');
  });

  it('reads "under a minute" rather than 0m', () => {
    const r = holdStateLine(ask({ deadline: NOW + 30_000 }), NOW);
    expect(r?.line).toBe('waiting on nick · goes ahead in under a minute if unanswered');
  });

  it('a team ask waits on "anyone", never "the human"', () => {
    const r = holdStateLine(ask({ to: null, tier: 'blocking' }), NOW);
    expect(r?.line).toBe('waiting on anyone · holds until answered');
  });

  it('held names who has not answered and who is stopped', () => {
    const r = holdStateLine(ask({ state: 'held', tier: 'blocking' }), NOW);
    expect(r?.line).toBe('nick has not answered · stanley is holding');
    expect(r?.title).toBe(
      'The window ran out on a blocking ask. The asker is paused and re-notifying; nothing proceeded.',
    );
  });

  it('risk_accepted says the asker went ahead — a fact about the asker, not a verdict on the human', () => {
    const r = holdStateLine(ask({ state: 'risk_accepted' }), NOW);
    expect(r?.line).toBe('stanley went ahead without nick');
  });

  it('stranded says nobody was home, and that nothing proceeded', () => {
    const r = holdStateLine(ask({ state: 'stranded' }), NOW);
    expect(r?.line).toBe('nobody home to answer · stanley is holding');
    expect(r?.title).toBe('A blocking ask with no reachable answerer. Held, not proceeded (ADR 153).');
  });

  it('lapsed says it went unanswered and the asker proceeded', () => {
    const r = holdStateLine(ask({ state: 'lapsed' }), NOW);
    expect(r?.line).toBe('went unanswered · stanley went ahead');
  });

  it('leaves the settled verdicts alone — those already render', () => {
    for (const state of ['accepted', 'declined', 'resolved', 'deferred'] as const)
      expect(holdStateLine(ask({ state }), NOW), state).toBeNull();
  });

  it('never uses a supervisor word — the human is a member', () => {
    // brand + PRODUCT.md: an ask waits on a member; it is not "pending approval" and the human
    // is not an approver. The tier tokens themselves must not reach the visible line either.
    const states = ['open', 'held', 'stranded', 'lapsed', 'risk_accepted'] as const;
    for (const state of states)
      for (const tier of ['blocking', 'standard', 'advisory'] as const) {
        const r = holdStateLine(ask({ state, tier }), NOW);
        if (!r) continue;
        expect(r.line, `${state}/${tier}`).not.toMatch(
          /approval|pending|escalated|blocked|supervisor/i,
        );
        expect(r.line, `${state}/${tier} leaks the protocol token`).not.toMatch(
          /\b(blocking|standard|advisory|risk_accepted)\b/,
        );
      }
  });
});
