import { describe, expect, it } from 'vitest';
import { resolvePosture } from './posture.js';

describe('resolvePosture — roster chip source (ADR 138)', () => {
  it('is offline when activity is offline', () => {
    expect(resolvePosture({ activity: 'offline' })).toBe('offline');
    expect(resolvePosture({ activity: 'offline', availability: { status: 'away' } })).toBe(
      'offline',
    );
  });

  it('lets explicit away/dnd outrank a live activity (ADR 044)', () => {
    expect(resolvePosture({ activity: 'working', availability: { status: 'away' } })).toBe('away');
    expect(resolvePosture({ activity: 'idle', availability: { status: 'dnd' } })).toBe('away');
  });

  it('is working when live with a reported task', () => {
    expect(resolvePosture({ activity: 'working' })).toBe('working');
    expect(resolvePosture({ activity: 'working', availability: { status: 'available' } })).toBe(
      'working',
    );
  });

  it('is idle when live without a reported task', () => {
    expect(resolvePosture({ activity: 'idle' })).toBe('idle');
    expect(resolvePosture({ activity: 'idle', availability: null })).toBe('idle');
    expect(resolvePosture({ activity: 'idle', availability: { status: 'available' } })).toBe(
      'idle',
    );
  });
});
