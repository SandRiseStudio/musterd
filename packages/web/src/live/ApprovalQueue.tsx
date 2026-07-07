import './ApprovalQueue.css';
import { ApprovalCard, type ApprovalRequest, type GrantLifetime } from './ApprovalCard';

/**
 * The admin approval queue — the list surface around Cleo's single-card ApprovalCard (ADR 072). It
 * renders every open claim/teammate request, drives the approve(lifetime)/deny interaction, and
 * settles each card in place (pending → approved/denied) so the admin sees the outcome before it
 * fades. Built on the card's settled UI types (`ApprovalRequest`/`GrantLifetime`), NOT on the P3.1
 * request wire contract (Jasmine's lane, unsettled) — the data source is injected via props, so only
 * a thin adapter changes when `GET /requests` + `POST /requests/:id/decide` land (ADR 069 P3).
 */

/** What the admin decided for a request — tracked so a card settles in place. Owned by the parent
 * (ADR 072) so the reception banner and this queue derive "pending" from one source and never disagree. */
export type Decision =
  | { kind: 'approved'; lifetime: GrantLifetime; at: number }
  | { kind: 'denied'; at: number };

/** Whether a request still counts as pending: not decided this session and not past its window.
 * Shared by the queue header and the reception banner so their counts always match. */
export function isPendingRequest(
  r: ApprovalRequest,
  decided: Map<string, Decision>,
  now: number,
): boolean {
  return !decided.has(r.id) && r.expiresAt > now;
}

export function ApprovalQueue({
  requests,
  decided,
  onApprove,
  onDeny,
  now = Date.now,
}: {
  requests: ApprovalRequest[];
  /** Session decisions keyed by request id — owned by the parent so the banner count stays in sync. */
  decided: Map<string, Decision>;
  /** Fired when the admin approves — wire to POST /requests/:id/decide once P3.1 lands. */
  onApprove: (id: string, lifetime: GrantLifetime) => void;
  /** Fired when the admin denies — wire to POST /requests/:id/decide (deny) once P3.1 lands. */
  onDeny: (id: string) => void;
  /** Injectable clock — lets tests/fixtures pin "now"; defaults to the real wall clock. */
  now?: () => number;
}) {
  // Pending (unsettled, not expired) first — most urgent (soonest expiry) on top; settled sink below.
  const ordered = [...requests].sort((a, b) => {
    const pa = isPendingRequest(a, decided, now()) ? 0 : 1;
    const pb = isPendingRequest(b, decided, now()) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.expiresAt - b.expiresAt;
  });

  const pendingCount = requests.filter((r) => isPendingRequest(r, decided, now())).length;

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
                onApprove={(lifetime) => onApprove(req.id, lifetime)}
                onDeny={() => onDeny(req.id)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
