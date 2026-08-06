import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adrStatus, isAcceptedAdr } from './adr-status.ts';

/**
 * The ADR status parser behind `change-adr:check` rule 3 (Decision immutability).
 *
 * THE BUG THIS EXISTS TO PREVENT, measured 2026-08-05: the matcher was
 * `/^-\s*Status:\s*accepted\s*$/im`, whose `\s*$` demanded the status be the bare word and nothing
 * else. That silently disabled the rule for **94 of the 223 accepted ADRs** — and for the wrong
 * ones, because the house style annotates the status with shipping detail. ADR 131 (`accepted —
 * design frozen; increments 2–6 are the build arc`) was unprotected, so PR #733 rewrote its frozen
 * `## Decision` with CI green.
 *
 * WHY THESE TESTS READ THE REAL CORPUS. A hand-written fixture saying `- Status: accepted` passed
 * the old matcher perfectly. The defect was never in the shape anyone would write down — it was in
 * the gap between that shape and the 247 files on disk. A synthetic-only test would have shipped
 * green beside this bug for as long as it existed, which is exactly what it did.
 */
const decisionsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'decisions');
const adrFiles = readdirSync(decisionsDir).filter((f) => /^\d{3}-.*\.md$/.test(f));
const read = (f: string) => readFileSync(join(decisionsDir, f), 'utf8');

describe('adrStatus — the four shapes the real corpus uses', () => {
  it('reads a bare status', () => {
    expect(adrStatus('- Status: accepted')).toBe('accepted');
  });

  // 86 files. The single largest class, and the one the end-anchored regex dropped.
  it('reads an ANNOTATED status — shipping detail after the token is house style', () => {
    expect(adrStatus('- Status: accepted — implemented 2026-06-25')).toBe('accepted');
    expect(adrStatus('- Status: accepted — design frozen; increments 2–6 are the build arc')).toBe(
      'accepted',
    );
    expect(adrStatus('- Status: accepted (built + merged 2026-07-06 — PRs #129/#130)')).toBe(
      'accepted',
    );
  });

  // ADRs 224, 227, 228.
  it('reads a BOLD KEY', () => {
    expect(adrStatus('- **Status:** accepted')).toBe('accepted');
    expect(adrStatus('- **Status:** accepted — increment 1 shipped')).toBe('accepted');
  });

  // ADRs 077, 206, 231, 233, 235.
  it('reads a status with NO LEADING DASH and a bold, capitalised value', () => {
    expect(adrStatus('Status: **Accepted**')).toBe('accepted');
    expect(adrStatus('**Status:** accepted — implemented 2026-06-30')).toBe('accepted');
  });

  it('still distinguishes the other statuses rather than calling everything accepted', () => {
    expect(adrStatus('- Status: proposed')).toBe('proposed');
    expect(adrStatus('- Status: **draft** — 2026-07-17')).toBe('draft');
    expect(adrStatus('- Status: superseded by ADR 013 (2026-06-15)')).toBe('superseded');
    expect(adrStatus('# 999 — no status line here\n\n## Context')).toBeNull();
  });

  // ADR 010. Accepted, then partly superseded — the token is what it was accepted as, and a
  // superseded decision is MORE historical rather than less, so it stays frozen.
  it('treats "accepted; superseded by …" as accepted, so its Decision stays frozen', () => {
    expect(isAcceptedAdr('- Status: accepted; the `member_busy` refusal is superseded by ADR 017')) //
      .toBe(true);
  });

  it('freezes only `accepted` — widening to superseded/proposed is a rule change, not a parse fix', () => {
    expect(isAcceptedAdr('- Status: superseded by ADR 013')).toBe(false);
    expect(isAcceptedAdr('- Status: proposed')).toBe(false);
    expect(isAcceptedAdr('- Status: draft')).toBe(false);
  });
});

describe('adrStatus over docs/decisions as it actually is', () => {
  it('finds a status on every ADR — an unparsed one is silently unprotected', () => {
    const missing = adrFiles.filter((f) => adrStatus(read(f)) === null);
    expect(missing).toEqual([]);
  });

  it('only ever yields the four statuses the corpus defines', () => {
    const seen = new Set(adrFiles.map((f) => adrStatus(read(f))));
    expect([...seen].sort()).toEqual(['accepted', 'draft', 'proposed', 'superseded']);
  });

  // The regression guard with teeth. The old matcher scored 129 here; the corpus has far more
  // accepted ADRs than that, and the gap WAS the bug. Asserting "most of them" rather than an exact
  // count keeps this honest as ADRs are added, while still failing loudly if a future status-line
  // style change re-opens the hole for a whole class of files.
  it('protects the great majority of accepted ADRs, not the 58% the old regex managed', () => {
    const accepted = adrFiles.filter((f) => isAcceptedAdr(read(f)));
    const oldRegex = /^-\s*Status:\s*accepted\s*$/im;
    const oldWouldCatch = adrFiles.filter((f) => oldRegex.test(read(f)));

    expect(accepted.length).toBeGreaterThan(oldWouldCatch.length + 80);
    expect(accepted.length / adrFiles.length).toBeGreaterThan(0.85);
  });

  // The specific files that motivated the fix — named so a regression points at a real ADR rather
  // than at a count.
  it.each(['131', '144', '145', '227', '224', '077', '206', '231'])(
    'ADR %s is accepted and therefore Decision-frozen',
    (n) => {
      const file = adrFiles.find((f) => f.startsWith(`${n}-`));
      expect(file, `no ADR ${n} on disk`).toBeDefined();
      expect(isAcceptedAdr(read(file!))).toBe(true);
    },
  );
});
