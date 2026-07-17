import type { MemberSummary } from '@musterd/protocol';
import {
  accountStatusException,
  capabilityBadges,
  initial,
  isFeatureBehind,
  memberColor,
  rosterOrder,
  rosterPrimaryChip,
} from './format';
import { CollapseButton, PanelRail } from './PanelChrome';

/**
 * The roster rail — presence posture (ADR 138) plus governance exceptions/capabilities (ADR 073/070).
 * Primary chip is server-projected `posture` (`working`·`idle`·`away`·`offline`); account_status only
 * paints when disabled/banned/archived. Read-only: enforcement lives server-side.
 */
export function RosterPanel({
  roster,
  collapsed = false,
  onCollapse,
  daemonBuild,
  daemonEpoch,
}: {
  roster: MemberSummary[];
  collapsed?: boolean;
  onCollapse?: () => void;
  /** The daemon's build ref (ADR 135) — operator detail, shown in the seat's skew tooltip. */
  daemonBuild?: string | undefined;
  /** The daemon's feature epoch (ADR 148) — a live seat below it gets a calm `behind` hint. */
  daemonEpoch?: number | undefined;
}) {
  const members = [...roster].sort(rosterOrder);
  const admins = members.filter((m) => m.capabilities?.is_admin).length;

  return (
    <aside
      className={`lc-roster${collapsed ? ' is-collapsed' : ''}`}
      aria-label="Team roster and governance"
    >
      {collapsed && onCollapse && (
        <PanelRail side="mid" label="Roster" hint={String(members.length)} onExpand={onCollapse} />
      )}
      <header className="lc-roster__head">
        <span className="lc-roster__title">ROSTER</span>
        <span className="lc-roster__count">
          {members.length} seat{members.length === 1 ? '' : 's'}
          {admins > 0 && ` · ${admins} admin`}
        </span>
        <span className="lc-roster__spacer" />
        {onCollapse && <CollapseButton side="mid" label="the roster" onClick={onCollapse} />}
      </header>
      <div className="lc-roster__rows">
        {members.length === 0 && (
          <p className="lc-roster__empty">No seats on this team yet.</p>
        )}
        {members.map((m) => (
          <SeatRow key={m.id} m={m} daemonBuild={daemonBuild} daemonEpoch={daemonEpoch} />
        ))}
      </div>
    </aside>
  );
}

function SeatRow({
  m,
  daemonBuild,
  daemonEpoch,
}: {
  m: MemberSummary;
  daemonBuild?: string | undefined;
  daemonEpoch?: number | undefined;
}) {
  const kind = m.kind === 'human' ? 'human' : 'agent';
  const online = m.presence !== 'offline';
  // Feature-skew (ADR 148): a *live* seat whose attested feature epoch is below the daemon's is missing
  // capabilities that landed later — the one meaningful, actionable skew (reload the seat). This replaces
  // the old raw build-SHA "stale" chip, which fired an alarm on every benign drift even though genuine
  // wire-incompatibility is already refused at the handshake (so a present seat is always compatible).
  // The build ref stays only as operator detail in the tooltip; it is never itself the trigger.
  const memberBuild = m.presences?.[0]?.build ?? undefined;
  const memberEpoch = m.presences?.[0]?.epoch ?? undefined;
  const epochBehind = isFeatureBehind(m, daemonEpoch);
  const skewTitle = epochBehind
    ? `Behind on features — this seat is on epoch ${memberEpoch}, the team is on ${daemonEpoch}. ` +
      `Reload it to pick up recent capabilities.` +
      (memberBuild && daemonBuild ? ` (build ${memberBuild.slice(0, 7)} vs ${daemonBuild.slice(0, 7)})` : '')
    : undefined;
  // Reclaimable (ADR 105): seat held within reclaim grace. Chip shows `reconnecting` via
  // offline_reason (ADR 141); no separate recon label.
  const reconnecting = !online && m.reclaimable === true;
  // Residency (ADR 131): an enrolled offline seat is not unreachable — a directed act wakes it;
  // `resumable` only while the capture sits inside the harness's ~30d GC horizon (inc 5), which is
  // exactly why the wire carries a timestamp and not a boolean.
  const wakeable = !online && !reconnecting && m.wakeable === true;
  const resumable =
    wakeable && m.resumable_at != null && Date.now() - m.resumable_at < 30 * 24 * 60 * 60 * 1000;
  const chip = rosterPrimaryChip(m);
  const accountEx = accountStatusException(m.account_status);
  const badges = capabilityBadges(m.capabilities);
  const dotState = online ? 'on' : reconnecting ? 'recon' : 'off';
  const seatMod = online ? '' : reconnecting ? ' lc-seat--recon' : ' lc-seat--offline';

  return (
    <div className={`lc-seat${seatMod}`}>
      <span
        className={`lc-seat__dot lc-seat__dot--${dotState}`}
        title={online ? `online · ${m.presence}` : reconnecting ? 'reconnecting — seat held within reclaim grace' : 'offline'}
      />
      <span className="lc-seat__avatar" style={{ background: memberColor(m.name, kind) }}>
        {initial(m.name)}
      </span>
      <div className="lc-seat__body">
        <div className="lc-seat__line">
          <span className="lc-seat__name">{m.name}</span>
          {/* Kind is universal (every seat is human/agent) so it always shows — keeps the column
              consistent; the optional role is an *additional* tag only when the seat carries one. */}
          <span className={`lc-seat__kind lc-seat__kind--${kind}`}>{kind}</span>
          {m.role && <span className="lc-seat__role">{m.role}</span>}
          {epochBehind && (
            <span className="lc-seat__behind" title={skewTitle}>
              behind
            </span>
          )}
        </div>
        <div className="lc-seat__gov">
          <span
            className={`lc-stat lc-stat--${chip.quiet ? 'quiet' : chip.tone}`}
            title={m.offline_reason ? `Offline reason: ${m.offline_reason}` : `Posture: ${chip.label}`}
          >
            {chip.label}
          </span>
          {accountEx && (
            <span
              className={`lc-stat lc-stat--${accountEx.tone}`}
              title={`Account status: ${m.account_status}`}
            >
              {accountEx.label}
            </span>
          )}
          {badges.map((b) => (
            <span key={b.key} className={`lc-cap lc-cap--${b.tone}`} title={b.title}>
              {b.label}
            </span>
          ))}
          {wakeable && (
            <span
              className="lc-stat lc-stat--quiet"
              title="Enrolled in harness residency (ADR 131) — a directed act wakes this seat"
            >
              wakeable
            </span>
          )}
          {resumable && (
            <span
              className="lc-stat lc-stat--quiet"
              title="A captured harness session is resumable — a wake continues the seat's own transcript"
            >
              resumable
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
