import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import liveCss from '../live/Live.css?url';
import { ApprovalQueue } from '../live/ApprovalQueue';
import type { ApprovalRequest, GrantLifetime } from '../live/ApprovalCard';

export const Route = createFileRoute('/approvals')({
  head: () => ({
    meta: [{ title: 'musterd — approvals' }],
    links: [{ rel: 'stylesheet', href: liveCss }],
  }),
  component: ApprovalsPage,
});

/* ── live wiring seam (ADR 069 P3.1, Jasmine's lane) ──────────────────────────
 * When the request lane lands, replace the fixtures below with a real source:
 *   - LOAD: GET /teams/:slug/requests (poll, or the WS request push from P3.2) → ApprovalRequest[]
 *   - DECIDE: onApprove/onDeny → POST /teams/:slug/requests/:id/decide { decision, lifetime }
 * The queue itself is contract-agnostic — it consumes the settled ApprovalCard UI types — so only this
 * route's data source + the two handlers change. The request→ApprovalRequest mapping (surface,
 * fingerprint, expiresAt) is provisional until Jasmine's P3.1 wire shape is final.
 */

/** Demo requests so the queue is viewable + interactive before the P3.1 endpoint exists. */
function demoRequests(now: number): ApprovalRequest[] {
  const min = 60_000;
  return [
    {
      id: 'req-1',
      seat: 'Pim',
      role: 'engineer',
      surface: 'claude-code',
      fingerprint: 'cc/4.8 · darwin · a1b2c3',
      requestedAt: now - 2 * min,
      expiresAt: now + 58 * min,
    },
    {
      id: 'req-2',
      seat: 'observer-3',
      surface: 'web',
      fingerprint: 'chrome/web · e4f5a6',
      requestedAt: now - 9 * min,
      expiresAt: now + 6 * min, // inside the urgent window — countdown turns hot
      batchCount: 3,
    },
    {
      id: 'req-3',
      seat: 'Cosmo',
      role: 'reviewer',
      surface: 'cursor',
      fingerprint: 'cursor/0.42 · 7b8c9d',
      requestedAt: now - 70 * min,
      expiresAt: now - 10 * min, // already past — renders as expired
    },
  ];
}

function ApprovalsPage() {
  const [requests] = useState<ApprovalRequest[]>(() => demoRequests(Date.now()));

  // SEAM: route to POST /requests/:id/decide once P3.1 lands. For now, record the intent.
  const onApprove = (id: string, lifetime: GrantLifetime) => {
    // eslint-disable-next-line no-console
    console.info('[approvals] approve', id, lifetime);
  };
  const onDeny = (id: string) => {
    // eslint-disable-next-line no-console
    console.info('[approvals] deny', id);
  };

  return (
    <main className="lc">
      <header className="lc__topbar">
        <span className="lc__word">musterd</span>
        <span className="lc__team">/ approvals</span>
        <span className="lc__spacer" />
        <span className="lc__status lc__status--idle">preview</span>
      </header>
      <div className="lc__canvas">
        <ApprovalQueue requests={requests} onApprove={onApprove} onDeny={onDeny} />
      </div>
    </main>
  );
}
