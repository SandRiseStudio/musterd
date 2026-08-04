import type { Parsed } from '../args.js';
import { signinCommand } from './board.js';

/**
 * `musterd live` (ADR 222) — open the office signed in as yourself, so the asks waiting on you are
 * answerable rather than merely readable.
 *
 * The cold-start sibling of the rail's own sign-in button: same one-shot nonce, same machine-local
 * boundary, different destination. The button is the everyday path once a browser is open; this is
 * for the case where it is not, and for the human who would rather start from a terminal.
 *
 * Why the office needed its own verb at all: `musterd board` shipped in ADR 170 and was redeemed
 * once, on release day, and never again. A surface you must decide to visit does not get visited.
 * The office is the one that stays open, and until now it was the one you could not sign into.
 */
export async function liveCommand(parsed: Parsed): Promise<number> {
  return signinCommand(parsed, 'live');
}
