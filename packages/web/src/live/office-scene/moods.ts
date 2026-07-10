export const DESK_MOODS = [
  'plant-collector',
  'color-collector',
  'coffee-ritualist',
  'tidy-tinkerer',
  'cozy-nook-keeper',
  'gadget-tinkerer',
] as const;

export type DeskMood = (typeof DESK_MOODS)[number];

export interface DeskMoodStyle {
  props: readonly string[];
  accent: string;
  ambient: 'steam' | 'glow' | 'breeze' | 'quiet';
}

const MOOD_STYLES: Record<DeskMood, DeskMoodStyle> = {
  'plant-collector': { props: ['plant', 'photo'], accent: '#6e9e52', ambient: 'glow' },
  'color-collector': { props: ['photo', 'lamp'], accent: '#d9557d', ambient: 'glow' },
  'coffee-ritualist': { props: ['coffee', 'water'], accent: '#c9744a', ambient: 'steam' },
  'tidy-tinkerer': { props: ['water'], accent: '#5b7fa6', ambient: 'quiet' },
  'cozy-nook-keeper': { props: ['lamp', 'plant'], accent: '#e1ad01', ambient: 'glow' },
  'gadget-tinkerer': { props: ['fan', 'lamp'], accent: '#2f8fb3', ambient: 'breeze' },
};

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function deskMoodFor(teamName: string, memberName: string): DeskMood {
  return DESK_MOODS[hash(`${teamName}\0${memberName}`) % DESK_MOODS.length]!;
}

export function deskMoodStyle(mood: DeskMood): DeskMoodStyle {
  return MOOD_STYLES[mood];
}
