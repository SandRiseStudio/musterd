import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../packages/cli/src/args.ts';
import { blockedByFlags } from '../../packages/cli/src/commands/send.ts';
import { SHARED_BLOCKER_GATES, sharedBlockerNotice } from './shared-blocker-notice.mjs';

/**
 * Incident convergence increment 2 — the bootstrap half.
 *
 * Increment 1 put the reporting norm in the on-demand skill body, which a seat that just hit a red
 * has no reason to open; the measured result was zero reports. The teaching moved to the moment of
 * need: a shared CI gate that fails prints the norm and the exact command. This costs no session
 * context budget (nick's increment-1 call) and reaches exactly the seats who hit the red.
 *
 * The gate ALSO supplies the canonical gate string. Clustering is exact-match on `gate`, so two
 * seats must be able to state it identically without coordinating — printing it removes that
 * coordination problem instead of hoping two agents phrase a check name the same way.
 */
describe('sharedBlockerNotice', () => {
  const notice = sharedBlockerNotice(SHARED_BLOCKER_GATES.a11yContrast);

  it('states the norm with its own guard — not a blanket excuse for a red', () => {
    // The norm is "a red your diff CANNOT touch". Without that condition it reads as permission to
    // report your own bug and walk away, which is the opposite of the intent.
    expect(notice).toMatch(/can't touch|cannot touch/i);
    expect(notice).toMatch(/park/i);
  });

  it('names the canonical gate string so two seats cluster without coordinating', () => {
    expect(notice).toContain('ci:gates/A11y contrast');
  });

  it('prints a command the CLI actually accepts', () => {
    // The whole mechanism dies quietly if the printed line and the flag drift apart, so the printed
    // command is parsed back through the real CLI parser rather than eyeballed.
    const line = notice
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('musterd send'));
    expect(line).toBeDefined();

    const argv = (line as string).match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? [];
    expect(argv.slice(0, 2)).toEqual(['musterd', 'send']);

    const parsed = parseArgs(argv.slice(2));
    const out = blockedByFlags(parsed.flags, undefined);
    expect(out).toEqual({
      act: 'status_update',
      report: { gate: 'ci:gates/A11y contrast' },
    });
  });

  it('is inert for a gate nobody shares', () => {
    expect(sharedBlockerNotice(null)).toBe('');
    expect(sharedBlockerNotice(undefined)).toBe('');
  });
});
