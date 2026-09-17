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
