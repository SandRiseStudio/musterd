import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = () => readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8');

describe('landing page', () => {
  it('uses the typographic hero, not the canvas office scene', () => {
    expect(src()).toContain('LightHero');
    expect(src()).not.toMatch(/components\/Hero\/Hero|office-scene/);
  });
  it('no longer pulls the /live stylesheet', () => {
    expect(src()).not.toContain('Live.css');
  });
  // The office is the first thing below the fold and above the player (homepage-copy-spec §3):
  // the hero keeps the first screen because the install command is what that screen is for.
  it('shows the office between the hero and the player', () => {
    const order = src();
    expect(order).toContain('OfficeProof');
    expect(order.indexOf('<LightHero')).toBeLessThan(order.indexOf('<OfficeProof'));
    expect(order.indexOf('<OfficeProof')).toBeLessThan(order.indexOf('<StreamSection'));
  });
});

// homepage-copy-spec §4.2 / §5. The picture is the point of this section, and two properties of it
// are load-bearing rather than cosmetic.
describe('the office section', () => {
  const office = readFileSync(
    new URL('../components/site/OfficeProof.tsx', import.meta.url),
    'utf8',
  );
  // Comments stripped for the negative assertions below: a guard against a string RENDERING must
  // not fire on the prose explaining why it does not. Caught by this file on 2026-09-18, where the
  // doc comment's "a visitor between sessions saw nothing" tripped the state-neutrality check.
  const rendered = office.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Criterion 4: the alt text is already written, shipping and reviewed on /watch. Retyping it is
  // how two surfaces start describing the same image differently.
  it('renders the still with the IMPORTED alt, never a retyped one', () => {
    expect(office).toContain('WATCH_COPY.stillAlt');
    expect(office).toContain('alt={WATCH_COPY.stillAlt}');
    expect(rendered).not.toMatch(/alt="[^"]/);
  });

  // A still and not the live canvas, because the scene costs ~51 ms/draw on a GPU-less box and a
  // marketing page must not charge that to a visitor (lane 01M2TM6C6XF6). If someone ever mounts
  // the scene here, this is the test that should stop them.
  it('uses the static capture, not the office scene', () => {
    expect(office).toContain('office-still.png');
    expect(rendered).not.toMatch(/office-scene|mountOffice|OfficeScene/);
  });

  // Below the fold, so it must not be able to shift layout while it loads (criterion 5).
  it('cannot shift layout: explicit dimensions, lazy and async', () => {
    expect(office).toMatch(/width=\{1200\}/);
    expect(office).toMatch(/height=\{630\}/);
    expect(office).toContain('loading="lazy"');
    expect(office).toContain('decoding="async"');
  });

  // The two closing sentences answer "whose office is this?" — without them a picture of OUR
  // office reads as a virtual office for the reader's agents (ADR 320 §1).
  it('keeps the sentences that say whose office this is', () => {
    expect(office).toContain('This is our team');
    expect(office).toContain('npx @musterd/cli init');
  });

  // The caption is true whether the channel is live or dark, and invents no schedule (spec §2).
  it('captions the still with a state-neutral line', () => {
    expect(office).toContain('A still from the stream. The office is live while the team is working.');
    expect(rendered).not.toMatch(/between sessions|offline/i);
  });
});

// ADR 320 decision 5 (2026-09-16): the landing leads with names, never with containment, and the
// category noun is never bare (decision 4).
describe('landing copy under ADR 320 §5', () => {
  const hero = readFileSync(new URL('../components/site/LightHero.tsx', import.meta.url), 'utf8');
  const whatIs = readFileSync(new URL('../components/site/WhatIs.tsx', import.meta.url), 'utf8');
  // Scoped 2026-09-17 after big-body's cross-family security read (act 01M2PH26PH): the unscoped
  // claim reads as a promise about everything an agent does, including the shell and filesystem
  // musterd never sees. What is true is the roster: acts the daemon accepted.
  it('the hero scopes the naming claim to the roster, and puts a human on it', () => {
    expect(hero).toContain('Every act on that roster has a name on it');
    expect(hero).not.toMatch(/Every act has a name on it/);
    expect(hero).toMatch(/human is on it too/);
  });
  it('the what-is heading qualifies "coordination layer" with the peers clause', () => {
    expect(whatIs).toContain('The coordination layer where agents and humans are peers');
    expect(whatIs).not.toMatch(/A coordination layer for agents you already run/);
  });
  it('the who-did-what card says what is observed and disclaims sandboxing', () => {
    expect(whatIs).toContain('what the harness observed, not what the agent declared');
    expect(whatIs).toContain('does not sandbox');
    // The disclaimer must name who DOES contain, in the same breath — a bare "we do not sandbox"
    // reads as an evasion to a security-minded reader (01M2PH26PH finding 1).
    expect(whatIs).toContain('your own host, sandbox and provider controls still do that');
    expect(whatIs).toContain('Every act on the roster names its member');
  });
  it('no surface here uses the critic\'s noun', () => {
    expect(hero + whatIs).not.toMatch(/swarm/i);
  });
});
