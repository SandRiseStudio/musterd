# 099 — /approvals and /audit gain office-scene banners, in office language

- Status: accepted — built 2026-07-06 (`ReceptionScene.tsx`/`.css` and `RecordShelf.tsx`/`.css` new;
  `routes/approvals.tsx` and `routes/audit.tsx` mount them; the previously-unstyled `/approvals` connect
  form is rewritten onto the same `.lc-form` pattern `/audit` already used)
- Date: 2026-07-06

## Context

ADR 097 retook `/live` and `/office-preview`'s chrome to daylight, completing the office design-system
arc's chrome work. `/approvals` and `/audit` are the two remaining admin surfaces in the `.lc` family —
functionally complete (ADR 072/073) but visually generic: plain forms and lists that happen to inherit
`--lc-*` tokens, with no office vocabulary of their own. Asked to scope the reskin's depth, the call was
the full office-scene treatment: real, data-reactive scene elements tied to the actual workflow, not
just a copy or color pass.

Auditing `/approvals` also surfaced a real, pre-existing defect: its connect form (`.lc__connect`,
`.lc__connect-card`) matched no CSS anywhere in `Live.css` — it rendered as bare unstyled HTML inputs,
unlike `/audit`'s already-styled `.lc-form` gate. A second defect: both pages' connected view mounted
their content inside bare `.lc__canvas`, which is `/live`'s three-column office/roster/stream grid —
with a single child, that left two-thirds of the width as empty gutter.

## Problem

Give `/approvals` and `/audit` their own office-scene visual identity — reactive to the real request
count / the real log's existence, not decorative filler — without duplicating the isometric canvas
engine (`office-scene/render.ts`), which is built around a full actor/pose/seating system that doesn't
map onto "requests waiting for a decision" or "a static record list." And fix the two layout defects
found along the way.

## Decision

**Two new flat-SVG, token-driven components, each reusing the isometric scene's visual vocabulary at
a fraction of its engineering weight — plus fixing the two pre-existing chrome bugs they exposed.**

- **`ReceptionScene`** (`live/ReceptionScene.tsx`) — a banner above the approval queue: a flat door
  illustration + a row of colored "visitor" chips, one per pending request (capped at 5, "+N more"
  beyond that), with an idle bob/pulse animation, alternating the two office identity hues
  (`--lc-agent`/`--lc-human`, ADR 036). Count-driven from `requests.length`, not per-identity — no
  enter/exit transition to key to a specific request id, so it reflows for free on every poll. An empty
  room reads as calm ("The front desk is quiet"), not broken.
- **`RecordShelf`** (`live/RecordShelf.tsx`) — a banner above (and inside the connect gate of) the audit
  log: a flat bookshelf illustration echoing the isometric scene's `bookshelf()` book-spine motif
  (`office-scene/render.ts`), with one accent-lit "open record" spine, captioned "The office's record
  book — every governance decision, permanently logged." Purely decorative (the log itself is real data;
  the shelf frames it) since a governance log has no natural per-entry scene analogue the way a queue of
  waiting visitors does.
- Both are **new, independent, flat-SVG** — not a refactor of `render.ts`'s private drawing helpers
  (`drawEntrance`, `bookshelf`, `avatar`, …), which are tuned for the isometric floor's coordinate math
  and painter's-order depth sort. Reusing them here would mean either dragging in the full actor/pose
  engine for a page banner or awkwardly widening `render.ts`'s exported surface for one new consumer.
  A hand-drawn flat SVG in the same palette (`--wood`, `--lc-agent`/`--lc-human`, `--lc-accent-bright`)
  reads as "the same office" without either cost.
- **`/approvals`'s connect form** is rewritten onto `/audit`'s existing `.lc-form` pattern (title, sub,
  labeled fields, error slot, connect button with a loading spinner slot) — parity, not a new pattern —
  with office-flavored copy ("Sign in at the front desk" / "Open the door") instead of the generic
  "connect" wording it never had styling for anyway.
- **Both pages' connected view** switches from bare `.lc__canvas` to `.lc__canvas.lc__canvas--companion`
  — the existing single-column full-width variant `/live`'s companion mode already defines — so the
  queue/log fills the page instead of one column of a three-pane grid built for a different route.

## Consequences

- `/approvals` and `/audit` now carry their own office vocabulary, reactive to live data, without a
  second rendering engine — the flat-SVG banners are ~60 lines each, no canvas, no RAF loop, no new
  test surface beyond what React components already get.
- The connect-form and full-width-layout fixes are net corrections, not scope creep introduced by this
  change — `/approvals`'s form was never styled and both pages' companion-grid bug predates this ADR.
- Verified 2026-07-06: typecheck clean, production build green (6 pages prerender), the 66-test
  office-scene suite unaffected (no `office-scene/` internals touched), full `format:check` gate green
  (prettier + roadmap + arch-trees + obs-evals + guidance + vocab, ADR 098). Visual QA via headless-
  Chrome screenshots: `/approval-preview` (the design-fixture harness, extended to show `ReceptionScene`
  above the card grid) and `/audit`'s connect gate confirm both banners render correctly; a temporary
  query-param fixture (`?layoutqa`, reverted before commit) confirmed the `--companion` full-width fix
  on `/approvals`'s connected state empirically rather than by CSS reasoning alone.

## Observability & Evaluation

n/a — a visual/copy change to two human-facing admin pages. It emits no coordination acts, joins no
team, and adds no spans — there is no agent behavior to eval or experiment on. Success was verified
visually (screenshot comparison, plus an empirical companion-grid layout check) and mechanically
(typecheck, build, the existing office-scene test suite, and the full `format:check` gate).
