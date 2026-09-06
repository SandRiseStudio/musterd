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
import {
  raiseReason,
  recordAttempt,
  recordRaise,
  recordSuppressed,
  shouldAttempt,
  shouldRaise,
  type GuardianStamp,
} from './damp.js';

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
  /**
   * Whether repeat raises are damped. Default true — production must never be undamped.
   *
   * The one sanctioned `false` is the install-time control probe, whose entire job is to make the
   * alert path fire observably and which is a dry run in every other respect. A probe that recorded
   * a raise would suppress its own `✓` on the next install inside the hour, and operators are told
   * to read a missing `✓` as "the alert path is untrusted" — the damper would manufacture exactly
   * the false silence it exists to prevent.
   */
  dampRaises?: boolean;
  log: (line: string) => void;
}

export interface GuardianActionReport {
  stamp: GuardianStamp;
  acted: Array<{
    class: GuardianClass;
    action: 'remediated' | 'alerted' | 'escalated' | 'observed' | 'suppressed';
  }>;
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

  /** `evidence` is what the classifier actually saw. It rides the ask body because that is the
   *  surface a seat adjudicates from — a raise that omits it forces hand-written SQL to answer
   *  "was this real?", which is how 22 identical daemon_down raises went unexamined. The OS
   *  notification stays short; the ask carries the detail.
   *
   *  Damped on the reason, not the class. Saying the same sentence every tick is how five
   *  byte-identical daemon_down asks landed in 33 minutes on 2026-08-21 — each one billing a
   *  human's attention for news they already had. A reason that CHANGED is not a repeat and is
   *  never withheld; an unchanged one waits out RAISE_WINDOW_MS and then re-raises carrying the
   *  count of what was withheld, so a persisting outage stays audible and the series is readable.
   *
   *  Returns whether the raise reached anyone — the caller audits its own success. */
  const raise = async (cls: GuardianClass, why: string, evidence?: string): Promise<boolean> => {
    const now = d.now();
    const damped = d.dampRaises !== false;
    const reason = raiseReason(cls, why, evidence);
    const memo = damped ? stamp.lastRaise[cls] : undefined;

    if (damped && !shouldRaise(stamp, cls, reason, now)) {
      stamp = recordSuppressed(stamp, cls, now);
      await audit('guardian.suppressed', {
        class: cls,
        suppressed: stamp.lastRaise[cls]?.suppressed ?? 1,
        since: memo?.raisedAt ?? null,
        reason_unchanged: true,
      });
      return false;
    }

    const withheld =
      memo !== undefined && memo.suppressed > 0
        ? `\n\n(${memo.suppressed} identical raises${memo.reason === reason ? '' : ' of the previous reason'} suppressed since ${new Date(memo.raisedAt).toISOString()}.)`
        : '';

    d.osNotify({ id: `guardian-${cls}-${now}`, title: `musterd guardian: ${cls}`, body: why });
    await d.sendAsk(
      `guardian: ${cls} — ${why}${evidence !== undefined ? `\n\n${evidence}` : ''}${withheld}`,
    );
    if (damped) stamp = recordRaise(stamp, cls, reason, now);
    return true;
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
        if (await raise(cls, 'auto-remediation already attempted within the hour — escalating')) {
          await audit('guardian.escalated', { class: cls });
          acted.push({ class: cls, action: 'escalated' });
        } else {
          acted.push({ class: cls, action: 'suppressed' });
        }
        continue;
      }
      stamp = recordAttempt(stamp, cls, d.now());
      const r = await d.runService(remedy);
      await audit('guardian.remediated', { class: cls, args: remedy, ok: r.ok });
      acted.push({ class: cls, action: 'remediated' });
      if (ALERTS_EVEN_ON_AUTO.has(cls)) {
        await raise(cls, `rolled back to ${stamp.lastGoodBuild} — verify when you can`);
      }
      continue;
    }

    // Alert tier, or an auto class with no usable remedy: crashloop without a known-good build, or
    // a class whose remediation is not built at all. `daemon_wedged` is the second kind by design
    // (ADR 389 §3 ships dark) — its raise must say THAT, because "no rollback target known" would
    // send a reader looking for a build pin that was never the question.
    const why =
      tier !== 'auto'
        ? 'needs a human'
        : cls in REMEDIATIONS
          ? 'auto tier but no rollback target known'
          : 'auto tier set but no remediation is built (ADR 389 ships dark) — alerting instead';
    const reached = await raise(cls, why, inc.evidence);
    if (reached) {
      await audit('guardian.alerted', { class: cls });
      acted.push({ class: cls, action: 'alerted' });
    } else {
      acted.push({ class: cls, action: 'suppressed' });
    }
  }

  return { stamp, acted };
}
