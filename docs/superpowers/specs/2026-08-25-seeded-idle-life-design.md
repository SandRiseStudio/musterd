# Seeded idle life — one office, every viewer

**Date:** 2026-08-25 · **Author:** miley, from stanley's scope ruling (act 01M0TT6GDN, 2026-08-24)
**Status:** spec for review — implementation follows the order in §6
**Lane:** 01M0GVPFKT (Delight E1, goal office-delight) · depends on Delight 0 (ADR 313) and A2 (#1053)

## 1. The problem, scoped

"Seeded idle life" carried three readings and was blocked for four days on which was meant.
Stanley's ruling closed it: reading 3 — life in an office with nobody in it — was never a rendering
question. It is a roster question and A2 already answered it (the room never empties; ledger seats
are the night shift). This lane keeps readings 1 and 2:

1. **A deterministic shared seed.** Every viewer of the stream sees the same office. Today each
   browser rolls its own ambient life — two people watching the same `/broadcast` see different
   rooms and have no way to know it. The stream stops being *a* view of the office and becomes
   *the* office.
2. **Ambient density.** More happening per idle minute, inside the invariants ADR 086 fixed:
   rAF 0/sec at rest is not negotiable, and the ~20 fps ambient cap stays (packages/web/AGENTS.md
   lists lowering it under *do not re-chase*).

**Bar / falsifiers.** (1) Two visible browsers on the same route, same team, over the same
interval, produce the **same beat log** — same slots, same actors, same beats, same order. (2)
Density is a beats-per-idle-minute number measured against the pre-change baseline, not an
adjective. §2 says why the falsifier is beat-log identity and not pixel identity.

## 2. Reading 1 — slot-hash, not a seeded stream

Two architectures were live. A **seeded PRNG stream** (seed once at mount, consume per decision)
desyncs the moment any browser consumes differently — one hidden tab, one skipped beat, one late
join, and the streams never re-align. A **stateless slot-hash** has no stream to desync: every
ambient decision is a pure function of inputs both browsers already share, so a viewer who missed
an hour reconverges on the next slot by construction. Slot-hash wins.

- **The lattice.** Wall-clock time divides into fixed **20 s slots**: `slot = floor(Date.now() /
  20_000)`. Each slot deterministically answers: does a beat fire, whose is it (pet / pair /
  member), which beat, and every roll inside it (walk hops, pause lengths, whether the dog tags
  along). One beat per slot at most — the slot is the scheduling quantum, replacing the stateful
  30–70 s re-arming timer.
- **The hash.** A pure module (`office-scene/ambientSeed.ts`): `roll(team, slot, purpose) → [0,1)`
  using the murmur-style mix the scene already trusts (`appearance.ts` hash, `render.ts`
  `shelfRnd` — "Seeded, never `Math.random()`"). `purpose` is a string tag (`'fire'`, `'actor'`,
  `'beat'`, `'phone-stop-2'`…) so one slot yields as many independent rolls as a beat needs.
  Key material is **team slug + slot + purpose** — nothing a viewer has to fetch. `daemonEpoch`
  was considered and rejected: it arrives from a best-effort async `/health` fetch, so mixing it
  in would make convergence contingent on a race.
- **Who can act is already shared.** The candidate pool (idle desk members, desk-neighbour pairs,
  pet state) derives from roster + act history, and every viewer holds the same ordered
  `(id, ts)` envelope list (deduped, sorted — `useLiveStream`). Same inputs + same hash = same
  pick. Candidate ordering must be canonical (sort by name) so array order never leaks in.
- **Preemption stays, and stays convergent.** The guards are untouched: a slot fires only into a
  quiet, visible, unreduced room, and real acts always preempt (ADR 086). Browsers that differ
  locally — one tab hidden, one mid-afterglow from a just-arrived act the other already finished —
  may skip a slot the other plays; they reconverge next slot because no state was consumed.
  Divergence is bounded at one beat, not accumulated forever, which is the property the falsifier
  actually needs.
- **Why not pixel identity.** The two surfaces already draw at different frame budgets (20 fps
  viewer cap vs capture fps) and coalesce differently (`broadcast.ts`), and wall clocks skew by
  seconds. Beat-log identity — observable via the `window.__office` handle the capture harness
  already uses — is the strongest claim the architecture can honestly make, and it is the one that
  matters: two viewers describing the room to each other describe the same room.
- **What gets the seam.** Every `Math.random()` on the ambient path: the scheduler picks
  (`index.ts` `fireAmbient`/`playAmbientBeat`), beat interiors (`actors.ts` errand geometry,
  chat durations), receptionist work beats (`receptionist.ts`), and the pet — which already takes
  an injectable `rng` (`pet.ts`, the pattern this generalizes; production call sites just start
  passing one). Out of scope: the sound engine (E2 owns sound), act choreography and confetti
  (driven by real acts, not idle life), appearance/seating/moods (already deterministic by name).

## 3. Reading 2 — density as a number

Today's scheduler fires one beat per 30–70 s (mean 50 s) room-wide — **~1.2 beats per idle
minute**, whether two members are seated or twelve. The slot lattice makes density a single
tunable: the per-slot fire probability.

- **Target: occupancy-scaled.** A populated room should read **~2.5–3 beats/idle-minute** (every
  20–25 s something small happens somewhere); a room of two stays nearer today's rate so a
  near-empty office doesn't read as twitchy. The exact curve is pinned in implementation against
  the measured baseline — the beat log gives the number on both sides of the change.
- **Invariants unmoved.** The scheduler remains a timer that wakes the loop per beat — raising
  density raises beat frequency, never resting rAF (still 0/sec between beats) and never the
  20 fps cap. `reduced` / `STILL` / hidden / suspended stand the scheduler down exactly as today.
- **Adaptive shedding (ADR 086 Phase 3) stays unbuilt** unless the density raise measurably needs
  it. If it is ever built it is a *local* override — a struggling device dropping beats breaks
  shared-view identity on that device by design, and documents itself as the one exception.

## 4. Bytes and constraints

- One new pure module (hash + slot math, ~40 lines) plus threading a `rng`/`roll` through existing
  call sites. Estimate **≤1.0 KB JS gzip**, all in the lazy office-scene chunk — initial JS
  (151.9/152.3) is untouched. No CSS.
- The 832 B tier-1 canvas trim (ADR 313: Tier-A FX onto canvas) remains available inside E-work
  on its own merits but is **not** part of E1 — it trades CSS bytes for JS bytes and deserves its
  own measurement, not a rider.
- `pnpm perf:check` after a fresh build in the same breath (the stale-dist trap, paid 2026-08-24).

## 5. Testing

- The pure module carries the falsifier directly: same (team, slot, purpose) → same value,
  different purpose → independent, distribution sanity.
- Scheduler determinism follows the `pet.test.ts` idiom — inject the roll, assert the beat log:
  two simulated viewers over the same slot range and roster produce identical logs; one viewer
  skipping slots reconverges.
- Density is asserted as expected-beats-per-minute from the fire probability, and measured live
  from the beat log on the built scene (the ADR 157 headless-CDP check can read
  `window.__office`).

## 6. Rollout

1. **E1a — the seam and the seed.** Land `ambientSeed.ts`, thread the roll through scheduler,
   actors, receptionist, pet. **Density parameters unchanged** — this PR proves beat-log identity
   while the room behaves exactly as before (the slot lattice replaces the 30–70 s timer at
   equivalent expected rate).
2. **E1b — the density number.** Occupancy-scaled fire probability, baseline measured before and
   after, the number recorded in the PR.

Order matters: identity first means every density claim in E1b is measured on a room that can be
measured — one beat log, not one per browser.

## 7. Non-goals

- Life in an empty office — folded into A2 by stanley's ruling; the roster owns it.
- Sound (E2, unspecced), act choreography/confetti determinism, appearance/seating (already
  deterministic).
- Protocol or wire changes — the seed keys off what viewers already hold (§11 of the program
  spec: no presentation data on the wire).
- Lowering or raising the 20 fps ambient cap.

## 8. Open questions (settle in implementation)

- Slot length: 20 s is the opening claim (short enough that skipped-slot divergence is invisible,
  long enough for the longest errand); E1a may tune it — it is one constant.
- Clock skew: 20 s slots tolerate ordinary NTP skew; if a real capture rig shows boundary
  straddling, anchor slots to the newest act `ts` instead of `Date.now()` — both viewers hold it.
- The occupancy→probability curve shape (step vs linear) — pick in E1b with the measured baseline
  in hand.
