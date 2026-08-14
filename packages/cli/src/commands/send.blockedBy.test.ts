import { BlockedBySchema } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { parseMeta } from '../args.js';
import { blockedByFlags } from './send.js';

/**
 * Incident convergence increment 2. Increment 1 shipped `meta.blocked_by` as the report contract and
 * then measured zero reports — one reason being that a CLI seat could not express it AT ALL:
 * `--meta` coerces only scalars (see the regression at the bottom), so the nested object the daemon
 * clusters on was unreachable from the command line. These tests pin the first-class flag that
 * replaces it.
 */
describe('blockedByFlags (incident convergence increment 2)', () => {
  it('is inert when no report is being filed', () => {
    expect(blockedByFlags({}, 'status_update')).toBeNull();
    expect(blockedByFlags({ to: 'stanley' }, 'message')).toBeNull();
  });

  it('--blocked-by alone files a report on status_update', () => {
    expect(blockedByFlags({ 'blocked-by': 'ci:gates/A11y contrast' }, undefined)).toEqual({
      act: 'status_update',
      report: { gate: 'ci:gates/A11y contrast' },
    });
  });

  it('carries --ref and --sig for the eventual owner', () => {
    expect(
      blockedByFlags(
        {
          'blocked-by': 'ci:gates/A11y contrast',
          ref: 'pr#840',
          sig: 'lc-office__caption /office-preview 2.83',
        },
        undefined,
      ),
    ).toEqual({
      act: 'status_update',
      report: {
        gate: 'ci:gates/A11y contrast',
        ref: 'pr#840',
        sig: 'lc-office__caption /office-preview 2.83',
      },
    });
  });

  it('an explicit --act status_update is accepted unchanged', () => {
    expect(blockedByFlags({ 'blocked-by': 'ci:x' }, 'status_update')?.act).toBe('status_update');
  });

  it('refuses to file a report on any other act — the report rides status_update (spec §1)', () => {
    expect(() => blockedByFlags({ 'blocked-by': 'ci:x' }, 'message')).toThrow(/status_update/);
    expect(() => blockedByFlags({ 'blocked-by': 'ci:x' }, 'ask')).toThrow(/status_update/);
  });

  it('refuses a valueless --blocked-by rather than filing an empty gate', () => {
    // `--blocked-by` with nothing after it parses as boolean true; the gate IS the cluster key, so a
    // missing one must be a refusal and not a report nobody can match.
    expect(() => blockedByFlags({ 'blocked-by': true }, undefined)).toThrow(/gate/);
  });

  it('drops empty --ref/--sig instead of failing the daemon-side shape check', () => {
    // BlockedBySchema requires min(1) on both; a shell that expands to nothing must not turn a good
    // report into a rejected envelope.
    const out = blockedByFlags({ 'blocked-by': 'ci:x', ref: '', sig: '' }, undefined);
    expect(out?.report).toEqual({ gate: 'ci:x' });
  });

  it('produces a report the daemon actually accepts', () => {
    const out = blockedByFlags(
      { 'blocked-by': 'ci:gates/A11y contrast', ref: 'pr#840' },
      undefined,
    );
    expect(BlockedBySchema.safeParse(out?.report).success).toBe(true);
  });

  it('regression: --meta cannot express the report, which is why the flag exists', () => {
    // dolly's increment-1 handback, pinned. Dotted keys stay flat and every value is a scalar, so
    // this never becomes { blocked_by: { gate } } and the daemon's clustering never sees it.
    const meta = parseMeta(['blocked_by.gate=ci:gates/A11y contrast']);
    expect(meta).toEqual({ 'blocked_by.gate': 'ci:gates/A11y contrast' });
    expect(BlockedBySchema.safeParse(meta?.['blocked_by']).success).toBe(false);
  });
});
