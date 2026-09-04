/**
 * The Seed vocabulary and its tray rule as plain TypeScript — no zod. `seeds.ts` builds its enum
 * from this tuple and re-exports the names, so the browser can render a seeds tray without pulling
 * a validator into its bundle (`guards.ts`).
 */

/** ADR 291: a captured Team idea before it becomes (or deliberately does not become) a Lane. */
export const SEED_STATES = [
  'open',
  'exploring',
  'needs_clarification',
  'clarified',
  'completed',
  'promoted',
] as const;
export type SeedState = (typeof SEED_STATES)[number];

/** ADR 319: one shared rule for the default Seed tray on every Surface. */
export const COMPLETED_SEED_TRAY_MS = 3 * 24 * 60 * 60 * 1_000;

export function seedInActiveTray(
  seed: { state: SeedState; completed_at: number | null },
  now = Date.now(),
): boolean {
  if (
    seed.state === 'open' ||
    seed.state === 'exploring' ||
    seed.state === 'needs_clarification' ||
    seed.state === 'clarified'
  ) {
    return true;
  }
  return (
    seed.state === 'completed' &&
    seed.completed_at !== null &&
    seed.completed_at >= now - COMPLETED_SEED_TRAY_MS
  );
}
