# In-session acceptance — design

- Date: 2026-07-31
- Lane: `01KYX2R8Y12YWBE1NXH16RE961` (izzo)
- Brainstormed with nick, 2026-07-31. Extends [ADR 192](../../decisions/192-outcome-acceptance.md).
- Status: design approved; ADR + implementation to follow.

## The problem, as observed

Lane `01KYRNHVWNKXR0M9PHGREJDN6S` (ADR 184) was submitted with `lane_submit`. The acceptance ask
routed to nick. nick was **already in izzo's session** and said "i accept" in chat.

There is no call that records that. The seat's options were:

1. `lane_resolve` — which stamps `unconfirmed`, the **silence-close** code path, or
2. make nick switch to the app/CLI and say the same word again.

izzo took (1) and posted a `status_update` saying the audit fact understates reality, because prose
was the only place the acceptance could go.

ADR 192 §Consequences models exactly two outcomes: the acceptor acts through musterd, or the owner
self-resolves "only on silence (unconfirmed)". A human who accepted **out of band, to the seat
itself** is neither, and lands in the bucket that means the opposite of what happened.

## Why it matters

`unconfirmed` is a metric, not a label. ADR 192 exists _because_ unverified self-closes were the
anti-pattern it wanted visible. Filing in-session human acceptance as `unconfirmed` inflates that
rate with its own success case, and the close-edge insights read a co-signed close as an unverified
one. **The instrument mismeasures in the direction that makes musterd look worse than it is** —
which is the direction nobody audits.

## What already works (and why this is small)

The machinery is present; only the last mile is missing.

- **`verified` is derived, never stored** — `done` + closer ≠ owner-at-close, pinned at close time
  (`packages/server/src/transport/http.ts`, the `lane.closed` emit). A close by nick on a lane owned
  by izzo _already_ lands `verified: true`, reason `counterpart_confirm`.
- **`--as <name>` resolves any vault identity** for the team (`packages/cli/src/commands/helpers.ts`,
  ADR 059). So `musterd lane resolve <id> --as nick` **already produces a confirmed acceptance
  today.**
- **`/board` already offers the acceptor's verbs** — a lane in `awaiting_acceptance` shows
  `confirm`/`sendback` to the acceptor, with the owner keeping only the degradation self-close
  (`packages/web/src/live/boardWrite.ts`).

The gap is therefore **naming and discoverability**, not capability: the acceptance verb is spelled
`resolve` — the same word as the self-close — and nothing ever tells the human the command.

## Scope, and what this explicitly does not claim

**This is ergonomics and metric accuracy. It is not a trust boundary.**

`--as` reads `~/.musterd/config.json` (mode 0600, owned by the user). Any process running as that
user — **including the agent seat** — can read it and authenticate as any human in it. Twelve human
credentials are in the live vault today. So a seat can already forge a human acceptance, via the CLI
or by staging an ADR 170 sign-in with a human's credential, and no amount of CLI design changes
that.

The lane's original done-when said "without the seat being able to manufacture it". **That bar is
not reachable on a single-user machine** and the ADR must say so rather than imply a guarantee it
does not provide. A real barrier requires custody the seat cannot read — OS keychain with a
biometric prompt, or a second device — which is a different and much larger piece of work.

Stating this plainly is the same discipline ADR 173 applies to absence: an overclaimed permission is
worse than an acknowledged gap. The current behaviour under-records; a self-attestation feature
would over-record; this design does neither, and gains the honest case — which is every real case.

## Design

### 1. `musterd lane accept <id> --as <you>`

Closes the lane as the acting human. **No protocol change and no new state** — it routes through the
existing terminal-close path, so `verified` derives to `true` with reason `counterpart_confirm`
exactly as a board confirm does.

The verb exists to be _guessable_. Today the same effect requires knowing that `resolve` doubles as
the acceptance verb, which no one would guess and the hint text does not teach.

**One new rule:** `accept` refuses when the resolved identity is the lane's own owner, with an error
pointing at `lane resolve` (the honest self-close). This is a **confusion guard, not a security
control** — it stops an honest seat from recording its own self-close as a co-sign. It is not
claimed to stop a dishonest one, per §Scope.

### 2. `musterd lane reject <id> --note "<concrete note>"`

Returns the lane to `active` and writes the frozen `lane.review_sent_back` audit action. Rejection
is half of acceptance and currently has **no CLI path at all** — the board is the only way to send
work back. ADR 192 asks for "a concrete note, not style nits", so the note is required, not optional.

### 3. `--board` — open the deep-linked board instead

Stages the acceptor's ADR 170 sign-in and opens `/board` focused on that lane, for when the acceptor
wants the lane brief and the acceptance checklist before deciding.

**Owner: miley** (standing rule: all frontend web UI is miley's). Scoped as its own increment: the
deep-link route + lane-focus behaviour on the board. The CLI flag is a thin caller and lands with
this lane; it degrades to printing the URL until miley's piece exists.

Note the constraint miley will hit: `musterd board` refuses an agent credential by design
(`packages/cli/src/commands/board.ts`) — the sign-in must be staged from the **human's** credential,
so `--board` is a command the human runs, never something the seat performs for them.

### 4. The last mile — teach the command at the moment it is needed

The gap closed today. Two surfaces gain the exact runnable command, lane id and acceptor name
pre-filled:

- **`lane_submit`'s returned hint**, which currently teaches only the degradation path ("on silence,
  `lane_resolve` yourself"). That asymmetry is why izzo reached for the wrong verb: the tool told him
  how to give up, and not how to succeed.
- **The daemon-composed acceptance ask body** (ADR 192 §5 already puts the checklist there).

This is the change that converts "i accept" in chat into one paste instead of a hunt.

## Consequences

- `unconfirmed` stops absorbing the in-session success case; close-edge insights stop reading
  co-signed closes as unverified.
- No audit action strings change (ADR 192 §4 keeps them frozen); no new lane state; no protocol
  addition. The new verbs are CLI surface over existing edges.
- Rejection becomes reachable without a browser for the first time.
- The credential-custody gap is documented, not fixed — and is worth its own lane.

## Testing

- **Unit:** `accept` refuses owner-as-acceptor; `reject` requires a note; `--as` resolution picks the
  named human.
- **Through-DB integration** (standing rule: one per new act edge): accept by a non-owner lands
  `lane.closed` with `verified: true` / `counterpart_confirm`; reject lands `lane.review_sent_back`
  and returns the lane to `active`.
- **Exercised for real, not just tested** — the acceptance path is the thing that misrecorded, so it
  gets run against a live lane on the real daemon before the lane is submitted.

## Open follow-ons (not this lane)

- **Credential custody** — the vault makes seat forgery possible; a real barrier needs keychain or
  second-device confirmation. Own lane.
- **Board deep link** — miley, per §3.
