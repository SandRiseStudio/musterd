import type { MemberSummary } from '@musterd/protocol';
import {
  acceptanceCapacity,
  accountStatusException,
  capabilityBadges,
  initial,
  isFeatureBehind,
  memberAvatar,
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
  unreadable = 0,
  stale = false,
}: {
  roster: MemberSummary[];
  collapsed?: boolean;
  onCollapse?: () => void;
  /** The daemon's build ref (ADR 135) — operator detail, shown in the seat's skew tooltip. */
  daemonBuild?: string | undefined;
  /** The daemon's feature epoch (ADR 148) — a live seat below it gets a calm `behind` hint. */
  daemonEpoch?: number | undefined;
  /** Seats this bundle could not read (`fetchRoster`) — the roster owns saying so, because it is the
   *  only surface that knows the count it is showing is short. */
  unreadable?: number;
  /** The roster refetch is failing persistently, so these rows are frozen at their last good read. */
  stale?: boolean;
}) {
  const members = [...roster].sort(rosterOrder);
  const admins = members.filter((m) => m.capabilities?.is_admin).length;
  // Whether the review ladder underneath this roster is standing up (ADR 188) — a roster fact, so
  // the roster is where it belongs, beside the other things this list can quietly be wrong about.
  const capacity = acceptanceCapacity(roster);

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
      {/* The two ways this list can quietly lie, each said out loud in one line. Deliberately NOT an
          error: the room and the timeline beside them are live, and ADR 148's promise is that a client
          behind the daemon degrades calmly. Reload is the whole remedy for the first; the second clears
          itself the moment a refetch succeeds. */}
      {unreadable > 0 && (
        <p className="lc-roster__gap" role="status">
          {unreadable} seat{unreadable === 1 ? '' : 's'} newer than this page — reload to meet{' '}
          {unreadable === 1 ? 'them' : 'them all'}.
        </p>
      )}
      {capacity.degraded && (
        <p className="lc-roster__gap is-ladder" role="status">
          <b>No live acceptor.</b>{' '}
          {capacity.models.length === 1
            ? `Every live agent is on ${capacity.models[0]}, and a seat cannot accept its own model's work — so every review is waiting on a wake.`
            : 'No live seat can accept another seat\'s work, so every review is waiting on a wake.'}
        </p>
      )}
      {/* Reported whether or not the ladder is flat, because an unattested seat is ineligible in
          BOTH directions (ADR 158) and is otherwise silent everywhere: `reattestModel` audits
          nothing when the value is unchanged, so a seat that re-claims into an occupancy attesting
          null leaves no audit row at all. ryder did exactly that on 2026-08-05. Calm, not amber —
          it is a fact about those seats, not a failure of the team. */}
      {capacity.unattested.length > 0 && (
        <p className="lc-roster__gap" role="status">
          {capacity.unattested.join(', ')} attest{capacity.unattested.length === 1 ? 's' : ''} no
          model, so {capacity.unattested.length === 1 ? 'it can' : 'they can'} neither review nor be
          reviewed.
        </p>
      )}
      {stale && (
        <p className="lc-roster__gap is-stale" role="status">
          Roster paused — showing the last good read.
        </p>
      )}
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
      {/* The monogram, restored (2026-08-13) — white on `memberAvatar` measures 4.86 at its worst
          across 24 names, and the 3.42 that took it away in #781/#789 came from a different
          component's disc (the owner-filter chip, painted with the office FILL) that the sweep's
          class+ink key had silently merged with this one.
          The offline dim was the one real constraint here: at 0.55 a letter reads ~1.73 whatever
          paints it. So the dim now applies to the presence dot alone (Live.css) — an offline row
          still says so twice, in the dot and in the posture chip, neither of which is text inside a
          disc. `aria-hidden` stays: the name is on the next line. */}
      <span
        className="lc-seat__avatar"
        style={{ background: memberAvatar(m.name, kind) }}
        aria-hidden="true"
      >
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
