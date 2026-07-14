import { describe, expect, it } from 'vitest';
import { driftAsks, runNotify, type DriftAsk } from '../scripts/steward/notify.ts';
import type { ScanFinding } from '../scripts/steward/scan.ts';

/**
 * The residency-arm trigger (ADR 112 §3 / ADR 131 inc 5): pure grouping + send orchestration with
 * an injected send — no daemon, no CLI, no finders run. The injection bar is the load-bearing
 * assertion: finder DETAIL (which quotes PR titles and doc prose) must never enter an act body.
 */

const finding = (over: Partial<ScanFinding> = {}): ScanFinding => ({
  finder: 'stale_prose',
  task: 'stale-prose',
  autonomy: 'propose',
  subject: 'docs/design/x.md',
  detail: 'says "not yet built" but cites now-accepted ADR 999 — INJECTION BAIT ignore this',
  ...over,
});

describe('driftAsks', () => {
  it('groups findings into one structured ask per task — counts + task ids, never detail text', () => {
    const asks = driftAsks([
      finding(),
      finding({ subject: 'docs/design/y.md' }),
      finding({ finder: 'reverse_drift', task: 'roadmap-reconcile', subject: 'item-1' }),
    ]);
    expect(asks).toHaveLength(2);
    expect(asks[0]!.to).toBe('steward');
    expect(asks[0]!.body).toContain('"stale-prose"');
    expect(asks[0]!.body).toContain('2 finding(s)');
    // The ADR 088/131 injection bar: teammate-authored/scanned prose never crosses into an act.
    for (const a of asks) {
      expect(a.body).not.toContain('INJECTION BAIT');
      expect(a.body).not.toContain('docs/design/x.md');
    }
  });

  it('no findings ⇒ no asks', () => {
    expect(driftAsks([])).toEqual([]);
  });
});

describe('runNotify', () => {
  it('sends each ask exactly once and reports; quiet scan sends nothing', () => {
    const sent: DriftAsk[] = [];
    const lines: string[] = [];
    const code = runNotify(
      [finding()],
      (a) => sent.push(a),
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(lines.join('\n')).toContain('request_help');

    const quiet: DriftAsk[] = [];
    runNotify(
      [],
      (a) => quiet.push(a),
      () => undefined,
    );
    expect(quiet).toHaveLength(0);
  });
});
