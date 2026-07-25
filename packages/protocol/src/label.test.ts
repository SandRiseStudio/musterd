import { describe, expect, it } from 'vitest';
import {
  SEAT_CHIP,
  capitalizeSeat,
  formatLabelWhen,
  parseSeatLabel,
  renderSeatLabel,
  renderTerminalTitle,
} from './label.js';

// A fixed "now": Sat 2026-07-25 12:00 local.
const NOW = new Date(2026, 6, 25, 12, 0).getTime();

describe('formatLabelWhen', () => {
  it('uses weekday form within six days, date form beyond', () => {
    const friday3pm = new Date(2026, 6, 24, 15, 0).getTime();
    expect(formatLabelWhen(friday3pm, NOW)).toBe('Fri 3p');

    const twoWeeksBack = new Date(2026, 6, 11, 15, 30).getTime();
    expect(formatLabelWhen(twoWeeksBack, NOW)).toBe('Jul 11 3p');
  });

  it('flips at exactly the six-day boundary (a weekday must never be ambiguous)', () => {
    const boundary = NOW - 6 * 86_400_000;
    expect(formatLabelWhen(boundary, NOW)).toMatch(/^Jul \d+ /);
    expect(formatLabelWhen(boundary + 1, NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}[ap]$/);
  });

  it('renders midnight and noon as 12a / 12p', () => {
    expect(formatLabelWhen(new Date(2026, 6, 25, 0, 5).getTime(), NOW)).toBe('Sat 12a');
    expect(formatLabelWhen(new Date(2026, 6, 25, 12, 0).getTime(), NOW)).toBe('Sat 12p');
  });
});

describe('renderSeatLabel / renderTerminalTitle', () => {
  it('renders the sidebar grammar with a capitalized seat', () => {
    const friday3pm = new Date(2026, 6, 24, 15, 0).getTime();
    expect(renderSeatLabel('miley', friday3pm, 'Daemon refresh', NOW)).toBe(
      `${SEAT_CHIP} Miley (Fri 3p) - Daemon refresh`,
    );
  });

  it('renders the terminal title lowercase, with and without a subject', () => {
    expect(renderTerminalTitle('stanley', 'agents-stanley')).toBe(
      `${SEAT_CHIP} stanley · agents-stanley`,
    );
    expect(renderTerminalTitle('stanley')).toBe(`${SEAT_CHIP} stanley`);
  });

  it('capitalizes only the first letter, leaving the rest alone', () => {
    expect(capitalizeSeat('miley')).toBe('Miley');
    expect(capitalizeSeat('dELLa')).toBe('DELLa');
  });
});

describe('parseSeatLabel — the three sweep states', () => {
  it('fully labeled: chipped and seated', () => {
    const p = parseSeatLabel(`${SEAT_CHIP} Miley (Fri 3p) - MCP list`, 'miley');
    expect(p).toMatchObject({ chipped: true, seated: true });
    expect(p.bare).toBe('Miley (Fri 3p) - MCP list');
  });

  it('pre-chip label: seated only, bare keeps the original timestamp text', () => {
    const p = parseSeatLabel('Stanley (Mon 9p) - ADR 153 terminal', 'stanley');
    expect(p).toMatchObject({ chipped: false, seated: true });
    expect(p.bare).toBe('Stanley (Mon 9p) - ADR 153 terminal');
  });

  it('untouched: neither chipped nor seated', () => {
    const p = parseSeatLabel('Daemon refresh and MCP reload', 'miley');
    expect(p).toMatchObject({ chipped: false, seated: false });
    expect(p.bare).toBe('Daemon refresh and MCP reload');
  });

  it('a chip for a DIFFERENT seat is chipped but not seated (never treated as done)', () => {
    const p = parseSeatLabel(`${SEAT_CHIP} Miley (Fri 3p) - x`, 'izzo');
    expect(p).toMatchObject({ chipped: true, seated: false });
  });

  it('seat match is case-insensitive (bindings are lowercase, labels capitalized)', () => {
    expect(parseSeatLabel('miley - something', 'Miley').seated).toBe(true);
  });
});
