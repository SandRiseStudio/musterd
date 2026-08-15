import { describe, expect, it } from 'vitest';
import { chooseAutoTarget, CLI_REPLY_TO_STYLE, type AutoTargetable } from './autoTarget.js';

/**
 * The rule that decides what an un-threaded `accept`/`decline` answers.
 *
 * WHY THIS FILE EXISTS AT ALL. The refusal it guards was written twice — once in
 * `packages/mcp/src/tools/send.ts` and once in `packages/cli/src/commands/send.ts` — and tested
 * neither time. Both copies carried a comment stating the correct invariant ("'newest open ask' is
 * never a safe guess") above a condition that did not implement it: they asked whether the GUESS
 * happened to be a lane acceptance, not whether the ACT being sent was a verdict that must not be
 * guessed. So the guard fired only when the newest open ask was itself a lane acceptance, and
 * stayed silent in every other arrangement of the same ambiguity.
 *
 * Measured on 2026-08-15, clearing a five-lane review queue: four accepts bound to guardian
 * `daemon_down` asks. Two of those lanes had a correct acceptance ask waiting and it was passed
 * over. Four guardian outage asks now read as answered by verdicts about unrelated pull requests,
 * and not one of the four lanes left `awaiting_acceptance`.
 */
const ask = (id: string, over: Partial<AutoTargetable> = {}): AutoTargetable => ({
  id,
  act: 'ask',
  from: 'guardian',
  ts: Number(id.slice(-4)),
  meta: null,
  ...over,
});
const laneAsk = (id: string, lane: string, over: Partial<AutoTargetable> = {}): AutoTargetable =>
  ask(id, { from: 'wanderer', meta: { lane_review: { lane } }, ...over });

/** Newest first, the order every caller hands in. */
const newestFirst = (...m: AutoTargetable[]): AutoTargetable[] =>
  [...m].sort((a, b) => b.ts - a.ts);

describe('chooseAutoTarget', () => {
  it('refuses when there is nothing open — and says how to name one', () => {
    const got = chooseAutoTarget([], 'accept');
    expect(got.kind).toBe('none');
    if (got.kind === 'none') expect(got.message).toMatch(/reply_to/);
  });

  it('binds the single open ask — ADR 067 convenience is the whole point, and it survives', () => {
    const only = ask('0001');
    const got = chooseAutoTarget([only], 'accept');
    expect(got.kind).toBe('target');
    if (got.kind === 'target') expect(got.target.id).toBe('0001');
  });

  it('binds a single open ask even when it IS a lane acceptance — one candidate is not a guess', () => {
    const got = chooseAutoTarget([laneAsk('0002', 'LANE-A')], 'accept');
    expect(got.kind).toBe('target');
  });

  // THE LANE'S DECLARED FALSIFIER. Two or more open asks, the newest NOT a lane acceptance.
  // Before this fix the accept bound silently to the newest; it must refuse and name the choices.
  it('REFUSES when several are open and the newest is not a lane acceptance (the live defect)', () => {
    const open = newestFirst(ask('0009'), laneAsk('0003', 'LANE-A'));
    const got = chooseAutoTarget(open, 'accept');
    expect(got.kind).toBe('refuse');
    if (got.kind === 'refuse') {
      // The correct target must be offered, not buried: it is the one the seat actually reviewed.
      expect(got.message).toContain('reply_to:0003');
      expect(got.message).toContain('LANE-A');
    }
  });

  it('still refuses when several are open and the newest IS a lane acceptance (no regression)', () => {
    const open = newestFirst(laneAsk('0009', 'LANE-B'), ask('0003'));
    expect(chooseAutoTarget(open, 'accept').kind).toBe('refuse');
  });

  it('KEEPS ADR 067 convenience when no lane acceptance is open at all', () => {
    // Deliberate, and load-bearing: answering the wrong request_help is recoverable, so the
    // convenience earns its place where nothing unrecoverable is at stake. This is the line the
    // first draft of this fix crossed — it refused on any ambiguity, and the adapter's own tests
    // caught it. The trigger is an unrecoverable candidate, not ambiguity as such.
    const open = newestFirst(ask('0009'), ask('0003'));
    const got = chooseAutoTarget(open, 'accept');
    expect(got.kind).toBe('target');
    if (got.kind === 'target') expect(got.target.id).toBe('0009');
  });

  it('refuses a `decline` on the same terms — a refusal lands on a named artifact too', () => {
    const open = newestFirst(ask('0009'), laneAsk('0003', 'LANE-A'));
    expect(chooseAutoTarget(open, 'decline').kind).toBe('refuse');
  });

  it("speaks each surface's own flag syntax — one rule, two conventions", () => {
    const open = newestFirst(ask('0009'), laneAsk('0003', 'LANE-A'));
    const cli = chooseAutoTarget(open, 'accept', CLI_REPLY_TO_STYLE);
    expect(cli.kind).toBe('refuse');
    if (cli.kind === 'refuse') {
      expect(cli.message).toContain('--reply-to 0003');
      expect(cli.message).not.toContain('reply_to:');
    }
    const none = chooseAutoTarget([], 'accept', CLI_REPLY_TO_STYLE);
    if (none.kind === 'none') expect(none.message).toContain('musterd inbox');
  });

  it('caps the offered list so a seat with a deep queue still gets a readable refusal', () => {
    const many = newestFirst(
      laneAsk('0500', 'LANE-Z'),
      ...Array.from({ length: 19 }, (_, i) => ask(String(1000 + i))),
    );
    const got = chooseAutoTarget(many, 'accept');
    expect(got.kind).toBe('refuse');
    if (got.kind === 'refuse') {
      expect(got.message.split('\n').length).toBeLessThanOrEqual(7);
      // …but the count is honest about how many there really are.
      expect(got.message).toContain('20');
    }
  });
});
