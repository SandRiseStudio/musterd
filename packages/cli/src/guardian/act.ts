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
  clearRaise,
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
  /**
   * In-band ask from the guardian seat to the `platform` holder (ADR 227 routing).
   *
   * Returns the act id when the send reports one, so a later discharge can name the thread it
   * closes (ADR 432). `void`/`null` is honoured and means "no thread to close" — the raise still
   * happened and simply cannot be auto-discharged, which is the pre-432 behaviour.
   */
  sendAsk: (body: string) => Promise<string | void | null>;
  /**
   * Close the thread of a raise whose condition has cleared (ADR 432).
   *
   * A `resolve`, not an `accept`: ADR 232 bars a service seat from the peer verbs, so `resolve` —
   * thread-terminal by ADR 025 and not a peer verb — is the only discharge guardian can express.
   * Optional so a caller that has not wired it degrades to the pre-432 behaviour rather than
   * failing a tick.
   */
  sendResolve?: (thread: string, body: string) => Promise<void>;
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
    const actId = await d.sendAsk(
      `guardian: ${cls} — ${why}${evidence !== undefined ? `\n\n${evidence}` : ''}${withheld}`,
    );
    if (damped)
      stamp = recordRaise(stamp, cls, reason, now, typeof actId === 'string' ? actId : null);
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

/** What {@link dischargeCleared} needs — the subset of {@link ActDeps} that a discharge uses. */
export interface DischargeDeps {
  stamp: GuardianStamp;
  sendResolve?: ActDeps['sendResolve'];
  audit: ActDeps['audit'];
  log: ActDeps['log'];
}

/**
 * Discharge every open raise whose class this tick did NOT classify (ADR 432), because that
 * absence IS the observation that the condition cleared.
 *
 * WHY IT IS ITS OWN FUNCTION, CALLED SEPARATELY (ADR 438). This began inside `actOn`, which
 * `guardianTick` calls only on the `incidents.length > 0` branch — so the discharge could run only
 * on a tick where something was STILL firing, and never on a fully healthy one. That is exactly
 * backwards: the healthy tick is the observation. The live proof was the whole log holding two
 * `guardian.cleared` rows, both on a tick whose first line was `incidents: publisher_failed`,
 * closing two raises that had been open a week — they cleared as a side effect of an UNRELATED
 * class firing. The direction of the bug is the bad one: the healthier the machine, the longer the
 * backlog, because a guardian with nothing firing could never discharge anything.
 *
 * WHY ANY OF IT EXISTS. Guardian is a `service` seat and ADR 232 bars a service seat from the peer
 * verbs by design — it never accepts, not even its own ask. So an incident ask had a human-based
 * discharge and no condition-based one, and the human never saw a reason to act because by the time
 * they looked the daemon was back. 55 asks on the hub daemon on 2026-09-21, 30 of them from August,
 * every one describing a condition that had long cleared. ADR 429's obligation rule then pins all
 * 55 into every bounded inbox read, forever, which is what made a slow leak a standing cost.
 *
 * DERIVED, NEVER STORED — the ADR 090/423 property. Nothing is written onto the ask. The ledger
 * gains a `guardian.cleared` row and the stamp forgets the memo; if the condition returns, the next
 * tick raises a NEW ask with a later position and it is owed again, with nothing to un-set.
 *
 * THE DIRECTION THIS MUST NOT ERR IN. Only a class absent from `firing` clears, and the caller owes
 * this function every class it classified — INCLUDING deferred ones, which are unconfirmed
 * sightings rather than evidence of health. A condition that persists is re-classified every tick
 * and so is never absent, so a real open incident cannot go quiet; it is the damper, not this, that
 * keeps a persisting outage from repeating itself.
 *
 * `withheld` is the other half of that direction, and the reason absence alone is not enough: a
 * class whose evidence this tick could not READ is absent from `firing` for a reason that is not
 * health (ADR 435 `unknown`, computed by `indeterminate`). It is neither cleared nor raised — the
 * raise simply stays open until a tick can actually see the condition, which is what the ADR means
 * by "does not clear an existing raise either".
 *
 * It sends no act beyond the `resolve` that closes the thread. Announcing recovery would answer
 * inbox volume with more inbox, which is the problem this lives inside.
 */
export async function dischargeCleared(
  firing: ReadonlySet<GuardianClass>,
  withheld: ReadonlySet<GuardianClass>,
  d: DischargeDeps,
): Promise<GuardianStamp> {
  let stamp = d.stamp;
  const open = Object.keys(stamp.lastRaise) as GuardianClass[];
  for (const cls of open) {
    if (firing.has(cls)) continue;
    if (withheld.has(cls)) {
      // Said out loud, because the alternative is silence that looks exactly like health — the
      // failure mode this whole clause exists to end. Only ever logged for a class that HAS an
      // open raise, so a quiet guardian stays quiet.
      d.log(
        `guardian.discharge_withheld ${JSON.stringify({
          class: cls,
          reason: 'this tick could not observe the condition — unknown is not recovery (ADR 435)',
        })}`,
      );
      continue;
    }
    const memo = stamp.lastRaise[cls];
    // The ledger row first: it is local and cannot fail the tick. The `resolve` is the part that
    // reaches the team, and it is best-effort for the same reason every other send here is — the
    // daemon may BE the incident, and a guardian that throws while recovering is worse than one
    // that stays quiet about a recovery.
    try {
      await d.audit('guardian.cleared', {
        class: cls,
        raised_at: memo?.raisedAt ?? null,
        suppressed: memo?.suppressed ?? 0,
        act: memo?.actId ?? null,
      });
    } catch (e) {
      d.log(`audit unreachable (${String(e)}) — continuing; the daemon may be the incident`);
    }
    const thread = memo?.actId;
    if (typeof thread === 'string' && thread.length > 0 && d.sendResolve !== undefined) {
      try {
        await d.sendResolve(thread, `guardian: ${cls} — cleared; this raise is closed`);
      } catch (e) {
        d.log(`resolve for ${cls} failed (${String(e)}) — the raise stays open; next tick retries`);
        // Keep the memo: an un-sent resolve means the ask is still owed, and forgetting it here
        // would leave a pinned obligation with nothing left that knows to close it.
        continue;
      }
    }
    stamp = clearRaise(stamp, cls);
  }
  return stamp;
}
