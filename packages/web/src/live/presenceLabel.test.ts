import { describe, expect, it } from 'vitest';
import {
  identityMeta,
  shortLaneState,
  shortModel,
  shortSurface,
  truncateWork,
} from './presenceLabel';

describe('shortSurface', () => {
  it('maps known harnesses to compact labels', () => {
    expect(shortSurface('claude-code')).toBe('claude');
    expect(shortSurface('cursor')).toBe('cursor');
    expect(shortSurface('codex')).toBe('codex');
    expect(shortSurface('cli')).toBe('cli');
    expect(shortSurface('web')).toBe('web');
  });
  it('returns empty for missing', () => {
    expect(shortSurface(null)).toBe('');
    expect(shortSurface(undefined)).toBe('');
  });
});

describe('shortModel', () => {
  it('shortens common model ids into glanceable labels', () => {
    expect(shortModel('claude-opus-4-5')).toBe('opus 4.5');
    expect(shortModel('gpt-5.6-luna-medium')).toBe('gpt 5.6');
    expect(shortModel('grok-4.5')).toBe('grok 4.5');
  });
  it('returns empty when unattested', () => {
    expect(shortModel(null)).toBe('');
    expect(shortModel('unknown')).toBe('');
  });
});

describe('identityMeta', () => {
  it('joins surface · model when both present', () => {
    const m = identityMeta({ surface: 'cursor', model: 'grok-4.5' });
    expect(m.line).toBe('cursor · grok 4.5');
    expect(m.title).toContain('cursor');
    expect(m.title).toContain('grok-4.5');
  });
  it('omits the line when both surface and model are empty', () => {
    expect(identityMeta({}).line).toBeNull();
  });
  it('appends role to title always, and to line when set', () => {
    const m = identityMeta({ surface: 'cli', model: null, role: 'backend' });
    expect(m.line).toBe('cli · backend');
    expect(m.title).toContain('backend');
  });
});

describe('truncateWork', () => {
  it('leaves short titles alone', () => {
    expect(truncateWork('ship it')).toBe('ship it');
  });
  it('ellipsis long titles at maxChars', () => {
    const t = truncateWork('a'.repeat(40), 32);
    expect(t.length).toBe(32);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('shortLaneState', () => {
  it('maps in-flight states to short chips', () => {
    expect(shortLaneState('active')).toBe('active');
    expect(shortLaneState('blocked')).toBe('blocked');
    expect(shortLaneState('claimed')).toBe('claimed');
    expect(shortLaneState('ready_for_review')).toBe('review');
  });
  it('returns null for done/abandoned/null', () => {
    expect(shortLaneState('done')).toBeNull();
    expect(shortLaneState(null)).toBeNull();
  });
});
