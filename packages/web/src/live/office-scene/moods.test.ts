import { describe, expect, it } from 'vitest';
import { DESK_MOODS, deskMoodFor, deskMoodStyle } from './moods';

describe('desk moods', () => {
  it('assigns a stable mood from the Team and Member identity', () => {
    expect(deskMoodFor('revive', 'miley')).toBe(deskMoodFor('revive', 'miley'));
    expect(deskMoodFor('revive', 'miley')).not.toBe(deskMoodFor('other-team', 'miley'));
    expect(DESK_MOODS).toContain(deskMoodFor('revive', 'miley'));
  });

  it('does not depend on roster order', () => {
    const before = ['miley', 'lizzo', 'stanley'].map((name) => deskMoodFor('revive', name));
    const after = ['stanley', 'miley', 'lizzo'].map((name) => deskMoodFor('revive', name));
    expect(after).toEqual([before[2], before[0], before[1]]);
  });

  it('exposes bounded visual styles for every mood', () => {
    for (const mood of DESK_MOODS) {
      const style = deskMoodStyle(mood);
      expect(style.props.length).toBeGreaterThan(0);
      expect(style.props.length).toBeLessThanOrEqual(3);
      expect(style.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
