# Office polish design

## Goal

Make the live isometric office feel warmer, more personal, and more delightful while preserving the
functional readability of the Team, Member, Presence, Surface, and Act model.

## Direction

Use **lived-in studio** as the visual foundation, with **golden thread** as the signature interaction
language. Revive remains responsible for Member animation; the polish work should improve the staging
around those animations rather than replace the rig.

## Stable-random desk moods

Members do not yet have durable roles or personalities. Until they do, assign each Member a deterministic
desk mood from a fixed set using a stable hash of the Team and Member name. The assignment must not depend
on render order, array position, random runtime state, or frame time.

Initial moods:

- plant collector
- color collector
- coffee ritualist
- tidy tinkerer
- cozy nook keeper
- gadget tinkerer

A mood controls a restrained combination of desk props, accent colors, and ambient details. It does not
change the Member's actual Presence, Acts, permissions, or behavior. The same Member should keep the same
mood across reloads and sessions until explicit profile data exists.

## Golden thread

Meaningful Acts can briefly create a soft mustard visual relationship between the relevant Members or
locations. Use it for handoff, request_help, accept, resolve, and broadcast-like events where a spatial
relationship adds understanding.

The thread should:

- use the canonical mustard accent;
- appear as a short-lived, low-contrast path or glow;
- respect reduced motion;
- avoid obscuring labels, monitors, or characters;
- rate-limit repeated events so the office remains calm.

The thread is a visual cue, not a new protocol field or Act.

## Revive choreography polish

First verify whether the Revive rig is loading in the web Surface and whether the expected animation state
is being advanced. If the rig is unavailable, retain the existing code-drawn fallback.

When the rig is available, improve the choreography through bounded staging:

- add a small anticipation pause before a walk or handoff;
- make arrival and delivery settle into idle instead of stopping abruptly;
- vary gesture timing slightly while keeping the event semantics obvious;
- reserve larger room-wide reactions for broadcasts and steering;
- keep ambient gestures occasional and subordinate to real Acts.

Do not add a continuous animation loop solely for visual decoration.

## Accessibility and responsiveness

Reduced-motion mode removes golden-thread travel and ambient choreography while preserving readable state
and Act content. Canvas overlays must remain legible at narrow widths, and labels must continue to avoid
the stream and roster surfaces. Keyboard focus remains visible for any new interactive control.

## Non-goals

- adding roles or personalities to the protocol;
- changing protocol schemas;
- introducing new runtime dependencies;
- replacing Revive with another animation system;
- making the office a game HUD;
- making every desk visually loud or unique.

## Validation

- Verify stable mood assignment across reloads, resize, roster reorder, and Presence changes.
- Verify the existing Revive rig path and code-drawn fallback path.
- Verify golden-thread cues for representative Acts and reduced motion.
- Check narrow viewport layout and label collisions.
- Run the web package typecheck, lint, and relevant tests before implementation is considered complete.
