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
  it('the naming card says what is observed and disclaims sandboxing', () => {
    expect(whatIs).toContain('does not sandbox');
    // The disclaimer must name who DOES contain, in the same breath — a bare "we do not sandbox"
    // reads as an evasion to a security-minded reader (01M2PH26PH finding 1).
    expect(whatIs).toContain('your own host, sandbox and provider controls still do that');
  });
  // 2026-09-18, lane 01M2NS50HC (homepage-copy-spec §2/§4.4). #1537 scoped this card's FIRST
  // SENTENCE and left the heading and the tail standing, so the page scoped the claim in the
  // middle of a card that overclaimed at both ends. wanderer (01M2RDQYCG) and ghost (01M2RNPSF2)
  // each named this sentence family unprompted, without having read this page.
  it('the naming claim carries its scope in the HEADING, not only the body', () => {
    // Moved, not deleted: #1537's assertion was on the body clause 'Every act on the roster names
    // its member'. That clause is now the heading, in ADR 320 §5a's canonical wording.
    expect(whatIs).toContain('Every act on the roster has a name on it');
    expect(whatIs).not.toMatch(/Who did what is never a question/);
  });
  it('the card claims no containment and names the boundary instead', () => {
    expect(whatIs).not.toMatch(/nothing on the roster is anonymous/);
    expect(whatIs).not.toMatch(/no anonymous workers/);
    expect(whatIs).toContain('It names the work that goes through the team');
  });
  // Attestation is model identity at connect time (ADR 158/163), not a proof about tool calls.
  // Unscoped, "the record holds what the harness observed" reads as a tool-call transcript —
  // the weakest sentence on the page per both security reads.
  it('scopes what the harness observed to seat occupancy', () => {
    expect(whatIs).toContain('Who occupies a seat is what the harness observed');
    expect(whatIs).not.toMatch(/the record holds what the harness observed/);
  });
  it('no surface here uses the critic\'s noun', () => {
    expect(hero + whatIs).not.toMatch(/swarm/i);
  });
});

// The prerendered HTML of both pages shipped a facade badge reading LIVE and the label
// 'live broadcast', unconditionally, before any player loaded — while /watch read REAL liveness
// for its eyebrow and state line one element over. A string that is true in only one state may
// never be the fallback for an unknown state (watch-page-copy-spec §4.1; homepage-copy-spec §2).
describe('the player facade never asserts a state it cannot read', () => {
  const stream = readFileSync(
    new URL('../components/site/StreamSection.tsx', import.meta.url),
    'utf8',
  );
  const watch = readFileSync(new URL('../components/site/WatchPage.tsx', import.meta.url), 'utf8');
  /**
   * Comments are stripped before matching, and that is the point rather than a convenience.
   * This gate is about what the component SHIPS, not about what a maintainer is allowed to
   * explain. Matching raw source means the next person who documents the rule types the banned
   * string into a comment and gets a failure that looks like their code is wrong — which happened
   * twice while writing this change, and was "fixed" both times by rewording the explanation
   * instead of the code. A gate that punishes its own documentation teaches the wrong lesson.
   */
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it.each([
    ['StreamSection', stream],
    ['WatchPage', watch],
  ])('%s ships no live claim in its facade', (_name, raw) => {
    const source = code(raw);
    expect(source).not.toMatch(/>LIVE</);
    expect(source).not.toMatch(/live broadcast/);
    expect(source).toContain('musterd on Twitch');
  });
});
