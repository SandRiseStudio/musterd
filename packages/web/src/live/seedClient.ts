import { SeedListSchema, type Seed } from '@musterd/protocol';
import { apiGet, type LiveConfig } from './client';

/** Shared Seed projection for the read-only `/live` tray (ADR 319). Kept with the lazy tray so the
 * Seed schema does not join `/live`'s eager graph before someone opens it. */
export async function fetchSeeds(cfg: LiveConfig): Promise<Seed[]> {
  const raw = await apiGet<unknown>(cfg, `/teams/${encodeURIComponent(cfg.team)}/seeds`);
  return SeedListSchema.parse(raw).seeds;
}
