import './ApprovalQueue.css';
import { useEffect, useState } from 'react';
import { ApprovalCard, type ApprovalRequest, type GrantLifetime } from './ApprovalCard';

/**
 * The admin approval queue — the list surface around Cleo's single-card ApprovalCard (ADR 072). It
 * renders every open claim/teammate request, drives the approve(lifetime)/deny interaction, and
 * settles each card in place (pending → approved/denied) so the admin sees the outcome before it
 * fades. Built on the card's settled UI types (`ApprovalRequest`/`GrantLifetime`), NOT on the P3.1
 * request wire contract (Jasmine's lane, unsettled) — the data source is injected via props, so only
 * a thin adapter changes when `GET /requests` + `POST /requests/:id/decide` land (ADR 069 P3).
 */

/** What the admin decided for a request — the queue tracks this so a card settles in place. */
type Decision =
  | { kind: 'approved'; lifetime: GrantLifetime; at: number }
  | { kind: 'denied'; at: number };

export function ApprovalQueue({
  requests,
  onApprove,
  onDeny,
  now = Date.now,
}: {
  requests: ApprovalRequest[];
  /** Fired when the admin approves — wire to POST /requests/:id/decide once P3.1 lands. */
  onApprove: (id: string, lifetime: GrantLifetime) => void;
  /** Fired when the admin denies — wire to POST /requests/:id/decide (deny) once P3.1 lands. */
  onDeny: (id: string) => void;
  /** Injectable clock — lets tests/fixtures pin "now"; defaults to the real wall clock. */
  now?: () => number;
}) {
  // Decisions made this session, keyed by request id — drives the in-place pending → settled flip.
  const [decided, setDecided] = useState<Map<string, Decision>>(new Map());
  // A coarse tick so a still-pending request flips to `expired` the moment its window passes.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const approve = (id: string, lifetime: GrantLifetime) => {
    setDecided((prev) => new Map(prev).set(id, { kind: 'approved', lifetime, at: now() }));
    onApprove(id, lifetime);
  };
  const deny = (id: string) => {
    setDecided((prev) => new Map(prev).set(id, { kind: 'denied', at: now() }));
    onDeny(id);
  };

  // Pending (unsettled, not expired) first — most urgent (soonest expiry) on top; settled sink below.
  const ordered = [...requests].sort((a, b) => {
    const pa = decided.has(a.id) || a.expiresAt <= now() ? 1 : 0;
    const pb = decided.has(b.id) || b.expiresAt <= now() ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return a.expiresAt - b.expiresAt;
  });

  const pendingCount = requests.filter(
    (r) => !decided.has(r.id) && r.expiresAt > now(),
  ).length;

  return (
    <section className="aq" aria-label="Approval queue">
      <header className="aq__head">
        <span className="aq__title">APPROVALS</span>
        <span className="aq__count">
          {pendingCount} pending
          {requests.length > pendingCount && ` · ${requests.length - pendingCount} settled`}
        </span>
      </header>

      {requests.length === 0 ? (
        <p className="aq__empty">
          <strong>No requests waiting.</strong>
          Claim and teammate requests appear here for an admin to approve or deny.
        </p>
      ) : (
        <div className="aq__grid">
          {ordered.map((req) => {
            const decision = decided.get(req.id);
            if (decision?.kind === 'approved')
              return (
                <ApprovalCard
                  key={req.id}
                  kind="approved"
                  request={req}
                  lifetime={decision.lifetime}
                  approvedAt={decision.at}
                />
              );
            if (decision?.kind === 'denied')
              return (
                <ApprovalCard key={req.id} kind="denied" request={req} deniedAt={decision.at} />
              );
            if (req.expiresAt <= now())
              return <ApprovalCard key={req.id} kind="expired" request={req} />;
            return (
              <ApprovalCard
                key={req.id}
                kind="pending"
                request={req}
                onApprove={(lifetime) => approve(req.id, lifetime)}
                onDeny={() => deny(req.id)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
