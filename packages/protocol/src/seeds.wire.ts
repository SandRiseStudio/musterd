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

/**
 * Where a Seed was captured. `slack` arrives through the relay (ADR 248/311); `repo` is a
 * document-recorded intention — a `Follows-up:` marker or an undisposed forward reference in this
 * repo's own documents — captured by `pnpm intents:ingest` (ADR 373 increment 2). The relay
 * boundary itself stays Slack-only; widening THIS set is the whole schema delta ADR 373 authorizes.
 *
 * Here rather than in `seeds.ts` because the orientation brief carries a Seed's source
 * (`up_next_seeds`, ADR 373 increment 4) and the browser reads that brief through `guards.ts`.
 */
export const SEED_SOURCES = ['slack', 'repo'] as const;
export type SeedSource = (typeof SEED_SOURCES)[number];

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
