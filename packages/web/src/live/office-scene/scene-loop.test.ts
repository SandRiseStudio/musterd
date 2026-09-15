import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Lane 01M2JYBGMQ, finding 1 (delta, re-read by izzo, confirmed here against the running source).
 *
 * There are two doors out of "this room stopped being watched": the tab going hidden
 * (`visibilitychange`) and the panel collapsing (`setSuspended`). Coming back through EITHER one
 * asks the same question — is anything actually happening, and therefore does the rAF loop resume
 * or does the slow drift heartbeat? #1430 answered it in two places, and they disagreed:
 * `onVisibility` resumed the breath, `setSuspended(false)` painted one resting frame and left the
 * room frozen. Collapse a quiet office, re-expand it, and the breathing was gone for the rest of
 * the session — invisible in review, because the first expand looks right (drift is armed on init).
 *
 * WHY THESE ARE SOURCE ASSERTIONS AND NOT A ROUND TRIP. `mountOffice` is the DOM half of the scene
 * and this package's tests run under `environment: 'node'` — there is no canvas, no rAF and no
 * document to mount into, and nothing in the repo stands one up. The round trip delta asked for
 * (suspend true → false on a quiet room, assert the heartbeat is armed) is the test worth having
 * and it is NOT what these are; they hold the STRUCTURE that makes the bug unrepresentable —
 * one home for the decision — rather than the behaviour. That gap is real and stated, not covered over.
 */
const index = readFileSync(
  fileURLToPath(new URL('./index.ts', import.meta.url)),
  'utf8',
);

/** The body of a named function in the scene source — `function f()` or `const f = () =>` — brace-matched. */
function body(name: string): string {
  const at = [`function ${name}(`, `const ${name} = (`]
    .map((decl) => index.indexOf(decl))
    .find((i) => i > -1) ?? -1;
  expect(at, `no function ${name} in index.ts`).toBeGreaterThan(-1);
  const open = index.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < index.length; i++) {
    if (index[i] === '{') depth++;
    else if (index[i] === '}' && --depth === 0) return index.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe('coming back to a room that stopped being watched', () => {
  it('both doors ask one function, so they cannot answer differently', () => {
    expect(index).toMatch(/function reengage\(\)/);
    // The tab-visibility door.
    expect(body('onVisibility')).toContain('reengage()');
    // …and the collapse door, which is the one that was wrong.
    const suspend = index.slice(index.indexOf('setSuspended:'), index.indexOf('pokeGesture:'));
    expect(suspend).toContain('reengage()');
  });

  it('neither door decides for itself — only reengage picks loop-or-drift', () => {
    const suspend = index.slice(index.indexOf('setSuspended:'), index.indexOf('pokeGesture:'));
    for (const [door, src] of [
      ['onVisibility', body('onVisibility')],
      ['setSuspended', suspend],
    ] as const) {
      expect(src, `${door} arms the loop itself`).not.toMatch(/\bensureLoop\(\)/);
      expect(src, `${door} arms the heartbeat itself`).not.toMatch(/\bensureDrift\(\)/);
    }
  });

  it('reengage is the only place the two are chosen between', () => {
    // stopDrift stays where it is — a door may still STOP things on the way out; what it may not do
    // is decide what starts on the way back in.
    expect(body('reengage')).toMatch(/ensureLoop\(\)/);
    expect(body('reengage')).toMatch(/ensureDrift\(\)/);
  });

  it('"is this room alive?" has one home too — the predicate that drifts if copied', () => {
    expect(index).toMatch(/const alive = \(\)/);
    expect(body('reengage')).toContain('alive()');
    // The three-part liveness test must not be re-spelled anywhere else.
    const spelled = [...index.matchAll(/living\(\)\s*\|\|\s*actors\.active\(\)/g)];
    expect(spelled.length, 'the liveness predicate is written out more than once').toBe(1);
  });
});
