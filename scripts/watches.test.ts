import { describe, expect, it } from 'vitest';
import { list, parseWatch, scalar, validateWatch } from './watches.ts';

/*
 * Tests for the watch record — the parser half.
 *
 * The frontmatter subset here is hand-parsed rather than handed to a YAML engine (ADR 002), so
 * these tests carry the weight a library's own test suite would otherwise carry. The two cases
 * that matter most are the ones a YAML engine would get right for free: an empty scalar must not
 * become the empty string, and a block list must not swallow the key that follows it.
 */

const SAMPLE = `---
question:   Does X reach zero?
claim_ref:  docs/decisions/166-session-liveness-by-enumeration.md
falsifier:  "any instance of X is a finding"
population: workspaces with a live binding
void_if:
  - distinct-seat count changes by >25% within the window
  - packages/cli/src/host/** changes within the window
series:     ~/.musterd/research/adr-166-slot-sweep.jsonl
cadence:    5m
opened:     2026-08-21
opened_by:  izzo
revisit_by: 2026-09-04
status:     open
resolution:
---

Prose body.
`;

describe('parseWatch', () => {
  it('reads scalars, stripping quotes and padding', () => {
    const w = parseWatch('w.md', SAMPLE)!;
    expect(scalar(w, 'question')).toBe('Does X reach zero?');
    expect(scalar(w, 'falsifier')).toBe('any instance of X is a finding');
    expect(scalar(w, 'opened_by')).toBe('izzo');
  });

  it('reads a block list', () => {
    const w = parseWatch('w.md', SAMPLE)!;
    expect(list(w, 'void_if')).toHaveLength(2);
    expect(list(w, 'void_if')[1]).toBe('packages/cli/src/host/** changes within the window');
  });

  it('ends a block list at the next key rather than swallowing it', () => {
    const w = parseWatch('w.md', SAMPLE)!;
    expect(scalar(w, 'series')).toBe('~/.musterd/research/adr-166-slot-sweep.jsonl');
    expect(scalar(w, 'cadence')).toBe('5m');
  });

  it('treats an empty scalar as absent, not as the empty string', () => {
    const w = parseWatch('w.md', SAMPLE)!;
    expect(scalar(w, 'resolution')).toBeUndefined();
  });

  it('keeps the prose body', () => {
    expect(parseWatch('w.md', SAMPLE)!.body.trim()).toBe('Prose body.');
  });

  it('returns null when there is no frontmatter', () => {
    expect(parseWatch('w.md', '# just a heading\n')).toBeNull();
  });
});

/*
 * The validator half. Each test names the single rule it proves can fail — a validator whose rules
 * cannot individually fail is the "falsifier that cannot fail" this whole primitive exists to stop
 * (wiki rule 3), so the suite is deliberately one assertion per rule.
 */

const ROOT = process.cwd();

/** Rewrite one scalar in SAMPLE, keeping every other field well-formed. */
function withField(key: string, value: string) {
  return parseWatch('w.md', SAMPLE.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${value}`))!;
}

describe('validateWatch', () => {
  it('accepts the well-formed sample', () => {
    expect(validateWatch(parseWatch('w.md', SAMPLE)!, { repoRoot: ROOT })).toEqual([]);
  });

  it('rejects a missing required scalar', () => {
    const w = parseWatch('w.md', SAMPLE.replace(/^population:.*$/m, ''))!;
    expect(validateWatch(w, { repoRoot: ROOT }).join(' ')).toContain('population');
  });

  it('rejects an empty void_if — no way to be void claims the population is immutable', () => {
    const w = parseWatch('w.md', SAMPLE.replace(/void_if:\n( {2}- .*\n)+/, 'void_if:\n'))!;
    expect(validateWatch(w, { repoRoot: ROOT }).join(' ')).toContain('void_if');
  });

  it('rejects revisit_by on or before opened', () => {
    expect(
      validateWatch(withField('revisit_by', '2026-08-21'), { repoRoot: ROOT }).join(' '),
    ).toContain('revisit_by');
  });

  it('rejects a claim_ref that does not exist — the post-back target must be real', () => {
    expect(
      validateWatch(withField('claim_ref', 'docs/decisions/999-nope.md'), { repoRoot: ROOT }).join(
        ' ',
      ),
    ).toContain('claim_ref');
  });

  it('rejects an unknown status', () => {
    expect(validateWatch(withField('status', 'paused'), { repoRoot: ROOT }).join(' ')).toContain(
      'status',
    );
  });

  it('requires a resolution once the watch is no longer open', () => {
    expect(validateWatch(withField('status', 'void'), { repoRoot: ROOT }).join(' ')).toContain(
      'resolution',
    );
  });

  it('rejects a resolution on a watch that is still open', () => {
    const w = parseWatch('w.md', SAMPLE.replace(/^resolution:$/m, 'resolution: "done"'))!;
    expect(validateWatch(w, { repoRoot: ROOT }).join(' ')).toContain('resolution');
  });

  it('accepts a terminal watch that carries its resolution', () => {
    const w = parseWatch(
      'w.md',
      SAMPLE.replace(/^status:.*$/m, 'status: void').replace(
        /^resolution:$/m,
        'resolution: "population unstable"',
      ),
    )!;
    expect(validateWatch(w, { repoRoot: ROOT })).toEqual([]);
  });

  it('rejects a date that parses but is not a real day', () => {
    expect(
      validateWatch(withField('opened', '2026-02-30'), { repoRoot: ROOT }).join(' '),
    ).toContain('opened');
  });
});
