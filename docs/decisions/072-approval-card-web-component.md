# 072 — Approval card web component (P3-prep, design-only)

- Status: accepted — 2026-06-29
- Date: 2026-06-29

## Context

ADR 069 phases the v0.3 governance build. P3 introduces the claim/grant handshake and the
**no-grant request/approval lane** (membership-model.md §"Claim flow" + ADR 069 spec-gap resolution 4):
when a session claims a seat without a pre-issued grant, the server signals an available admin who sees a
**one-keystroke approval card** showing the surface, seat/role requested, a harness fingerprint, and a
batched-claims summary. The admin picks the grant lifetime (once / N hours / until revoked) or denies.

P2 (ADR 071) shipped the governance substrate + audit log on the existing token auth. The credential
machinery (agent key, grants, claim frame) isn't built yet — that is P3. But the **admin-facing UI** for
the approval lane is design-only (no backend wiring required) and unblocks the P3 UX design review before
the breaking auth work lands.

## Decision

Build a self-contained `ApprovalCard` React component in `packages/web` using the existing `--lc-*` design
tokens. The component renders **four states**: `pending` (awaiting decision), `approved` (with the chosen
lifetime displayed), `denied`, and `expired` (request timed out after the 1-hour default window per ADR 069
spec-gap resolution 2).

### ApprovalCard props

```ts
interface ApprovalRequest {
  id: string; // request id (ULID)
  seat: string; // seat name or role + index requested (e.g. "Ada" or "backend-1")
  role?: string; // role the seat belongs to (e.g. "backend")
  surface: string; // harness surface (e.g. "claude-code", "cursor", "codex")
  fingerprint: string; // harness fingerprint (short hash shown so admin can recognise the device)
  requestedAt: number; // unix ms
  expiresAt: number; // unix ms (now + 1h default)
  batchCount?: number; // >1 = "N claims from this harness — approve all?"
}

type ApprovalState =
  | {
      kind: 'pending';
      request: ApprovalRequest;
      onApprove: (lifetime: GrantLifetime) => void;
      onDeny: () => void;
    }
  | { kind: 'approved'; request: ApprovalRequest; lifetime: GrantLifetime; approvedAt: number }
  | { kind: 'denied'; request: ApprovalRequest; deniedAt: number }
  | { kind: 'expired'; request: ApprovalRequest };

type GrantLifetime = 'once' | { ttl_hours: number } | 'standing';
```

### Visual language

- Inherits `--lc-*` tokens; styles in `ApprovalCard.css` (no edits to `Live.css`).
- **Pending**: a warm-bordered card with three lifetime action buttons (▸ once, ▸ 4h, ▸ standing) + a
  deny link. An expiry countdown shows the remaining window. Batched claims collapse into a badge
  ("×3 from this harness").
- **Approved**: green-tinted resolved state, lifetime badge, no actions.
- **Denied**: danger-tinted, no actions.
- **Expired**: faint/muted, clock icon, no actions.

### Preview route

A static `/approval-preview` route renders all four states with synthetic fixture data so the design can be
reviewed + iterated without a live daemon. Route file: `packages/web/src/routes/approval-preview.tsx`.
No changes to `routes/live.tsx`.

### What this ADR does NOT do

- No backend: no `POST /decide`, no WS `claim` frame, no grant issuance — all P3.
- No integration into `inbox --watch` or the CLI approval card (a separate P3 surface).
- No changes to June's four files (RosterPanel.tsx, live/format.ts, Live.css, routes/live.tsx).

## Observability & Evaluation

**Traces** — none. Design-only UI component; no server-side behavior to trace. The governed
`request.decide` audit verb this card will eventually trigger is ADR 071's substrate, not this card's.

**Eval** — success = the four states (pending/approved/denied/expired) render correctly under the
`--lc-*` theme tokens and survive `tsc` + `vite build`. Baseline: the `/approval-preview` route's
rendering of the four states (the design-review fixture).

**Experiment** — n/a — a design-only component; no agent-facing behavior to A/B.

## Consequences

- Unblocks P3 UX design review: the card can be iterated in the browser before the breaking auth work lands.
- Establishes the `GrantLifetime` type in the web layer; P3 can wire it to the real `POST /decide` endpoint.
- Builds on ADR 069 (the approval lane spec), ADR 071 (the audit substrate whose `request.decide` verb this
  card will eventually trigger), ADR 070 (the seat model whose `account_status` + capabilities context the
  card may display).
