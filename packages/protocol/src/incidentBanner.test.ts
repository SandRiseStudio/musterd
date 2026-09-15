import { describe, expect, it } from 'vitest';
import { incidentBannerLines } from './incident.js';

/**
 * The banner text is shared derivation, not per-surface prose (ADR 084). It lived only in the MCP
 * renderer through increments 1 and 2, so every CLI seat got no banner at all — on the surface that
 * most needs orientation, for the feature ADR 266 calls "the cheapest, highest-leverage piece"
 * precisely because the measured waste was seats STARTING SESSIONS into a shared red.
 *
 * The derivation was always shared (`deriveNext`, server-side). What drifted was the RENDERER. So
 * the words live here now, and a new surface gets them by importing rather than by remembering.
 */
describe('incidentBannerLines', () => {
  const NOW = 1_000_000_000;
  const base = {
    lane: '01ABC',
    gate: 'ci:gates/A11y contrast',
    owner_seat: null,
    opened_at: NOW - 120_000,
  };

  it('leads with the gate, the lane, and how long it has been open', () => {
    const [head] = incidentBannerLines(base, NOW);
    expect(head).toContain('ci:gates/A11y contrast');
    expect(head).toContain('01ABC');
    expect(head).toContain('2m');
  });

  it('always says the red may not be yours — the whole point of the banner', () => {
    expect(incidentBannerLines(base, NOW).join(' ')).toMatch(/not yours/i);
  });

  it('an owned incident names its owner and drops the countdown', () => {
    const lines = incidentBannerLines({ ...base, owner_seat: 'stanley' }, NOW).join(' ');
    expect(lines).toContain('owned by stanley');
    expect(lines).not.toMatch(/yours to claim/);
  });

  it('an unclaimed incident says how long it stays yours to take, and who it falls to', () => {
    const lines = incidentBannerLines(
      { ...base, claim_closes_at: NOW + 360_000, fallback_role: 'platform' },
      NOW,
    ).join(' ');
    expect(lines).toContain('UNCLAIMED');
    expect(lines).toMatch(/yours to claim for 6m/);
    expect(lines).toContain('falls to platform');
  });

  it('says outright when NOBODY holds the fallback role', () => {
    // The case that must never read as "someone catches this in ten minutes". An unowned incident
    // that nobody will ever be handed is a real state, and a seat deciding whether to pick it up
    // has to be told — otherwise the countdown converts it into a false belief that it is handled.
    const lines = incidentBannerLines(
      { ...base, claim_closes_at: NOW + 360_000, fallback_role: null },
      NOW,
    ).join(' ');
    expect(lines).toMatch(/NOBODY holds the fallback role/);
    expect(lines).not.toMatch(/falls to/);
  });

  it('after the window closes with nobody holding the role, says it will just sit', () => {
    const lines = incidentBannerLines(
      { ...base, claim_closes_at: NOW - 1, fallback_role: null },
      NOW,
    ).join(' ');
    expect(lines).toMatch(/sit unowned until someone takes it/);
  });

  it('after the window closes with a role holder, says it is routing there', () => {
    const lines = incidentBannerLines(
      { ...base, claim_closes_at: NOW - 1, fallback_role: 'platform' },
      NOW,
    ).join(' ');
    expect(lines).toMatch(/claim window closed, routing to platform/);
  });

  it('a brief from a pre-271 daemon renders exactly as increment 1 did', () => {
    // Both window fields absent (not null) — the old daemon never sent them. No countdown, no
    // claim-window clause, and nothing that reads as missing data.
    const lines = incidentBannerLines(base, NOW).join(' ');
    expect(lines).toContain('UNCLAIMED');
    expect(lines).not.toMatch(/claim|window|falls to|NOBODY/);
  });
});
