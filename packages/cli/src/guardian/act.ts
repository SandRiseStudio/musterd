/**
 * Guardian actions — remediate the safe classes, alert the rest, attribute everything
 * (spec §4–§5). Pure orchestration over injected effects; the tick (service guardian-tick)
 * supplies the real runners.
 *
 * Remediations shell the existing guarded `service` verbs — never a reimplemented bounce.
 * Crashloop rollback pins the last HEALTHY `/health.build` the stamp recorded; `--force` because
 * a crashlooping daemon cannot answer the live-session guard, and the guard failing open here
 * would leave prod down to protect sessions that are already disconnected.
 */
import type { NotifyItem } from '../notify/os.js';
import type { GuardianClass, GuardianTier, Incident } from './classify.js';
import { recordAttempt, shouldAttempt, type GuardianStamp } from './damp.js';

export interface ActDeps {
  now: () => number;
  stamp: GuardianStamp;
  tiers: Record<GuardianClass, GuardianTier>;
  runService: (args: string[]) => Promise<{ ok: boolean }>;
  osNotify: (n: NotifyItem) => void;
  /** In-band ask from the guardian seat to the `platform` holder (ADR 227 routing). */
  sendAsk: (body: string) => Promise<void>;
  /** Best-effort audit POST; callers must survive its failure. */
  audit: (action: string, detail: Record<string, unknown>) => Promise<void>;
  log: (line: string) => void;
}

export interface GuardianActionReport {
  stamp: GuardianStamp;
  acted: Array<{ class: GuardianClass; action: 'remediated' | 'alerted' | 'escalated' | 'observed' }>;
}

const REMEDIATIONS: Partial<Record<GuardianClass, (s: GuardianStamp) => string[] | null>> = {
  publisher_failed: () => ['refresh', '--live'],
  crashloop: (s) => (s.lastGoodBuild ? ['refresh', '--pin', s.lastGoodBuild, '--force'] : null),
};

/** Crashloop remediation alerts even on success — the spec's "acts and tells". */
const ALERTS_EVEN_ON_AUTO: ReadonlySet<GuardianClass> = new Set(['crashloop']);

export async function actOn(incidents: Incident[], d: ActDeps): Promise<GuardianActionReport> {
  let stamp = d.stamp;
  const acted: GuardianActionReport['acted'] = [];

  const audit = async (action: string, detail: Record<string, unknown>): Promise<void> => {
    try {
      await d.audit(action, detail);
    } catch (e) {
      d.log(`audit unreachable (${String(e)}) — continuing; the daemon may be the incident`);
    }
  };

  const alert = async (cls: GuardianClass, why: string): Promise<void> => {
    d.osNotify({ title: `musterd guardian: ${cls}`, body: why });
    await d.sendAsk(`guardian: ${cls} — ${why}`);
  };

  for (const inc of incidents) {
    const cls = inc.class;
    const tier = d.tiers[cls];

    if (tier === 'observe') {
      await audit('guardian.observed', { class: cls });
      acted.push({ class: cls, action: 'observed' });
      continue;
    }

    const remedy = tier === 'auto' ? (REMEDIATIONS[cls]?.(stamp) ?? null) : null;

    if (tier === 'auto' && remedy !== null) {
      if (!shouldAttempt(stamp, cls, d.now())) {
        await alert(cls, 'auto-remediation already attempted within the hour — escalating');
        await audit('guardian.escalated', { class: cls });
        acted.push({ class: cls, action: 'escalated' });
        continue;
      }
      stamp = recordAttempt(stamp, cls, d.now());
      const r = await d.runService(remedy);
      await audit('guardian.remediated', { class: cls, args: remedy, ok: r.ok });
      acted.push({ class: cls, action: 'remediated' });
      if (ALERTS_EVEN_ON_AUTO.has(cls)) {
        await alert(cls, `rolled back to ${stamp.lastGoodBuild} — verify when you can`);
      }
      continue;
    }

    // Alert tier, or an auto class with no usable remedy (crashloop without a known-good build).
    await alert(cls, tier === 'auto' ? 'auto tier but no rollback target known' : 'needs a human');
    await audit('guardian.alerted', { class: cls });
    acted.push({ class: cls, action: 'alerted' });
  }

  return { stamp, acted };
}
