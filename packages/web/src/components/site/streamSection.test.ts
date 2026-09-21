import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = () => readFileSync(fileURLToPath(new URL('./StreamSection.tsx', import.meta.url)), 'utf8');

/**
 * Source assertions (the repo has no DOM/hydration rig — see broadcast.stage.test.ts for the
 * pattern and the hydration incident these rules come from). The property under test: the
 * prerendered landing page owes Twitch nothing — the player exists only after an
 * IntersectionObserver, running in an effect on the client, says the section is visible.
 *
 * The MECHANISM changed under ADR 428 — a hand-built `<iframe>` became a `Twitch.Player`, so the
 * section can read liveness and show the still when the channel is dark — but every property these
 * tests were written to protect is unchanged, and each one is re-asserted here against the SDK.
 */
describe('the stream embed is deferred', () => {
  it('first render has no player: visibility state seeds false', () => {
    expect(src()).toMatch(/useState\(false\)/);
  });

  it('the player is constructed only behind the visibility flag', () => {
    const s = src();
    const ctor = s.indexOf('new twitch.Player');
    expect(ctor).toBeGreaterThan(-1);
    // The guard is an early return in the effect rather than a render-time ternary, so assert the
    // effect cannot reach construction without `visible`.
    expect(s.slice(0, ctor)).toMatch(/if \(!visible\) return;/);
  });

  it('ships no iframe of its own — the SDK builds it, and carries the autoplay grant', () => {
    // Measured 2026-09-16 (recorded in WatchPage.tsx): the SDK emits the same origin, path and
    // parameters as the hand-written iframe AND sets `allow="autoplay; fullscreen"`, which the
    // hand-written one never carried. ADR 302's muted-autoplay viewer count rests on that grant,
    // so a regression to a bare `<iframe>` here would silently remove the precondition again.
    expect(src()).not.toContain('<iframe');
    expect(src()).toContain('loadTwitchSdk');
  });

  it('an IntersectionObserver flips it, and is disconnected after', () => {
    expect(src()).toContain('IntersectionObserver');
    expect(src()).toMatch(/\.disconnect\(\)/);
  });

  it('parent comes from location.hostname so previews work', () => {
    expect(src()).toContain('location.hostname');
  });

  it('does not pre-inject off-screen: Twitch refuses autoplay unless the player is in view', () => {
    // A rootMargin here would load the player before it is visible; Twitch then logs
    // "Autoplay disabled … viewport visibility" and the embed never counts the viewer.
    expect(src()).not.toContain('rootMargin');
    expect(src()).toMatch(/threshold:/);
  });

  it('hands the player its own dimensions — it lays out from them, not from CSS', () => {
    // The same failure the iframe's width/height attributes fixed: sized only by CSS, the player
    // measured its pre-layout box and painted a postage stamp in the corner.
    expect(src()).toMatch(/width: '100%'/);
    expect(src()).toMatch(/height: '100%'/);
  });

  it('muted autoplay is still asked for, not just permitted', () => {
    expect(src()).toMatch(/muted: true/);
    expect(src()).toMatch(/autoplay: true/);
  });
});

/**
 * ADR 428's actual subject: one office slot, and the still is the state it shows when the channel
 * is not live. `unknown` shows the still too — it is what the prerendered HTML ships and what a
 * reader with a blocked SDK keeps, so it must be the state that claims least.
 */
describe('the still is the offline state, not a second office', () => {
  it('shows the still whenever nothing real is on the player', () => {
    // Widened by the replay (lane 01M32JE1ZP): "not live" is no longer sufficient, because a dark
    // channel may now be playing an actual recording. The still must yield to a STARTED replay
    // and to nothing else.
    expect(src()).toContain("liveness !== 'live' && !replaying");
  });

  it('stacks the still on the player rather than replacing it, so the box cannot resize', () => {
    const css = readFileSync(fileURLToPath(new URL('./StreamSection.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/\.ss__still\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.ss__player\s*\{[^}]*position:\s*relative/);
    // The mount is never conditionally rendered — if it were, the player would be torn down and
    // rebuilt on every liveness change, and each rebuild re-asks Twitch for autoplay.
    expect(src()).not.toMatch(/\{showStill[^}]*<div className="ss__mount"/);
  });
});

/**
 * The replay (lane 01M32JE1ZP): a dark channel plays past sessions instead of showing a
 * photograph of the room. The risk this introduces is not technical — it is that a recording of
 * this office is indistinguishable from a live view of it, so the caption becomes the only thing
 * telling a reader which they are looking at.
 */
describe('a dark channel replays real work, captioned as a replay', () => {
  it('asks for the collection through the player rather than a second embed', () => {
    // A second iframe would be a second office in one viewport — the exact composition ADR 428
    // removed — and would not count as a viewer either (ADR 302's autoplay gate).
    expect(src()).toContain('replayWhenDark(player, twitch.Player, TWITCH_COLLECTION');
    expect(src()).not.toMatch(/<iframe/);
  });

  it('tracks the replay separately from the channel state', () => {
    // `liveness` means the CHANNEL; `replaying` means the PLAYER. Folding one into the other
    // would make `dark` mean two different things depending on whether a collection loaded.
    expect(src()).toContain('const [replaying, setReplaying] = useState(false)');
  });

  it('captions three states, and never calls a replay live', () => {
    expect(src()).toContain('WATCH_COPY.stateReplay');
    expect(src()).toContain('WATCH_COPY.stateLive');
    // Live is read FIRST: a swap only ever follows a dark report, so the two can never both be
    // true — but the ordering is what makes that structural rather than incidental.
    expect(src()).toMatch(/liveness === 'live'\s*\?\s*WATCH_COPY\.stateLive/);
  });

  it('the replay caption leads with the word replay and does not imply a schedule', () => {
    const copy = readFileSync(fileURLToPath(new URL('./watchCopy.ts', import.meta.url)), 'utf8');
    const line = /stateReplay:\s*\n?\s*'([^']+)'/.exec(copy)?.[1] ?? '';
    expect(line.toLowerCase().startsWith('a replay')).toBe(true);
    expect(line).toMatch(/dark right now/);
    // No invented cadence — watch-page-copy-spec §2. The team keeps no schedule.
    expect(line).not.toMatch(/tomorrow|every day|daily|weekly|back at/i);
  });
});
