import { describe, expect, it } from 'vitest';
import { ActivitySchema } from './acts.js';
import { PostureSchema, resolvePosture } from './posture.js';

describe('resolvePosture — roster chip source (ADR 138; idle→active rename per presence-honesty §2.1)', () => {
  it('is offline when activity is offline', () => {
    expect(resolvePosture({ activity: 'offline' })).toBe('offline');
    expect(resolvePosture({ activity: 'offline', availability: { status: 'away' } })).toBe(
      'offline',
    );
  });

  it('lets explicit away/dnd outrank a live activity (ADR 044)', () => {
    expect(resolvePosture({ activity: 'working', availability: { status: 'away' } })).toBe('away');
    expect(resolvePosture({ activity: 'active', availability: { status: 'dnd' } })).toBe('away');
  });

  it('is working when live with a reported task', () => {
    expect(resolvePosture({ activity: 'working' })).toBe('working');
    expect(resolvePosture({ activity: 'working', availability: { status: 'available' } })).toBe(
      'working',
    );
  });

  it('is active when live without a fresh reported task', () => {
    expect(resolvePosture({ activity: 'active' })).toBe('active');
    expect(resolvePosture({ activity: 'active', availability: null })).toBe('active');
    expect(resolvePosture({ activity: 'active', availability: { status: 'available' } })).toBe(
      'active',
    );
  });
});

describe('idle→active wire rename — legacy `idle` accepted on read', () => {
  it('ActivitySchema reads old idle as active, never emits it', () => {
    expect(ActivitySchema.parse('idle')).toBe('active');
    expect(ActivitySchema.parse('active')).toBe('active');
    expect(ActivitySchema.parse('working')).toBe('working');
  });

  it('PostureSchema reads old idle as active', () => {
    expect(PostureSchema.parse('idle')).toBe('active');
    expect(PostureSchema.parse('active')).toBe('active');
  });
});
