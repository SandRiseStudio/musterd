import type { MemberSummary } from '@musterd/protocol';
import {
  accountStatusMeta,
  capabilityBadges,
  initial,
  memberColor,
  rosterOrder,
} from './format';
import { CollapseButton, PanelRail } from './PanelChrome';

/**
 * The governance roster rail — the accessible, semantic counterpart to the (decorative, aria-hidden)
 * constellation. It surfaces the v0.3 seat model the daemon now projects (ADR 070): each member's
 * account_status and effective capabilities. Read-only: this is the *observable* surface; enforcement
 * lives server-side (P2). A fully-generalist team reads calm — only governance deviations draw a badge.
 */
export function RosterPanel({
  roster,
  collapsed = false,
  onCollapse,
}: {
  roster: MemberSummary[];
  collapsed?: boolean;
  onCollapse?: () => void;
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
          <SeatRow key={m.id} m={m} />
        ))}
      </div>
    </aside>
  );
}

function SeatRow({ m }: { m: MemberSummary }) {
  const kind = m.kind === 'human' ? 'human' : 'agent';
  const online = m.presence !== 'offline';
  // Reclaimable (ADR 105): the seat reads offline but is held within its reclaim grace — a reservation
  // that may be reconnecting after a reload/blip. Surface it as "reconnecting" rather than a cold seat.
  const reconnecting = !online && m.reclaimable === true;
  const status = accountStatusMeta(m.account_status);
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
          {reconnecting && (
            <span className="lc-seat__recon" title="Seat held within its reclaim grace (ADR 105)">
              reconnecting
            </span>
          )}
        </div>
        <div className="lc-seat__gov">
          <span
            className={`lc-stat lc-stat--${status.quiet ? 'quiet' : status.tone}`}
            title={`Account status: ${status.label}`}
          >
            {status.label}
          </span>
          {badges.map((b) => (
            <span key={b.key} className={`lc-cap lc-cap--${b.tone}`} title={b.title}>
              {b.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
