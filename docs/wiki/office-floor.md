# The office floor — layout invariants and how to change it

Any floor edit is bound by measured invariants (stand-behind clearance, nav-grid rounding, seat-assignment hashing) — the working method is a throwaway probe that prints the walkability map and every pairwise gap, never coordinate guessing.

## The invariants (2026-08-02/03 overhaul, PRs #586–#590; falsify: layout.test.ts + nav.test.ts)

- Seat assignment is `hash % DESK_SLOTS.length` — changing the slot count reshuffles every member once per deploy; never promise cross-deploy seat stability.
- The nav grid is 15-unit cells rounding a footprint's edge to its starting cell — a clearance real by 5 units can be zero after rounding; probe with `walkable()`, don't arithmetic.
- The stand-behind invariant (60 open units behind every seat) forbids wall-flush room-facing desks, and a room-facing desk cannot go on the left wall (one built there measured a 5.6× door detour). Standing target: nothing closer than ~45 units to its neighbour.
- `Pod.size` is `1 | 2 | 4`; a solo needs stand-behind floor on one side (~175 units) where a pair needs both (~350) — the cheapest way to give a neighbour room.
- "Exactly two viewer-facing desks" is asserted by layout.test — an added `ns` duo breaks it; add duos as `ew`.
- Method: write a throwaway probe under `office-scene/__probe/` printing the ASCII walkability map, zone bounding boxes + pairwise gaps, and each seat's detour ratio; measure, move, re-measure, delete the probe.

## Contrast without darkening (2026-07-28, #483)

The floor runs sunlit-to-shaded, so no single fill separates from all of it — buy pop at the EDGE and UNDERNEATH (`--lc-paper-rim/drop/seat/sheen` tokens), keep every value on the warm axis (grey shadow on a warm floor reads as dirt), and add no blur (it paints on the /broadcast capture).

## Motion notes

The dog's gait derives reach from `STRIDE × MEAN_KX ÷ DOG_SIZE` so a resize cannot desync feet from ground speed; facing is a continuous eased mirror via `ctx.scale`, and heading commits only past |screen-x| > 0.34·d or it flutters on diagonals. Judge the dog at 4× on `/character-sheet`.
