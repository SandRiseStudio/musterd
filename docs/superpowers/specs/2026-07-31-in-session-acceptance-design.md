# In-session acceptance — design

- Date: 2026-07-31
- Lane: `01KYX2R8Y12YWBE1NXH16RE961` (izzo)
- Brainstormed with nick, 2026-07-31. Extends [ADR 192](../../decisions/192-outcome-acceptance.md).
- Status: superseded by [ADR 202](../../decisions/202-the-verdict-moves-the-lane.md) for the
  acceptance transition; the rejection-note persistence follow-up is recorded in ADR 204.

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
- **The acceptance Act now moves the lane** — ADR 202 makes an `accept` Act answering a
  `meta.lane_review` ask close the named lane, and a `decline` Act return it to `active`. The
  daemon uses the same close derivation as the board, and refuses to infer a lane from prose or
  an ambiguous latest ask (`packages/server/src/protocol/route.ts`).
- **`/board` offers the same acceptor verbs** — a lane in `awaiting_acceptance` shows
  `confirm`/`sendback` to the acceptor, with the owner retaining the sanctioned self-close
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

### 1. Use the existing acceptance Act, with the lane ask as its target

The accepted implementation is `musterd send --act accept --reply-to <lane-ask-id> <verdict>`;
rejection is the same shape with `--act decline` and a concrete note. The server extracts the lane
id only from the replied-to ask's structured `meta.lane_review`, then moves exactly that lane.
**No protocol state or new CLI lane verb is needed.**

The target is explicit because a considered verdict can take minutes and another ask may arrive in
the meantime. Automatic latest-ask targeting refuses when a lane acceptance is among multiple open
asks; it never guesses which lane the acceptor reviewed.

The owner case is intentionally not a separate guard. The shared close derivation records
`verified: false` when the owner answers their own lane, preserving the honest `self_close` meaning;
ADR 200 documents why credential custody is not a trust boundary on a single-user machine.

### 2. Persist the rejection note with the frozen audit action

`decline` returns the lane to `active` and writes the frozen `lane.review_sent_back` audit action.
The Act body, trimmed and bounded to 500 characters, is copied to `detail.note`. The lane's mutable
`detail` remains the board's current work description; it is not the durable acceptance verdict.
This keeps the concrete reason available to the owner and to audit consumers without changing the
frozen action name or the protocol schema.

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

This is the change that converts "i accept" in chat into one paste instead of a hunt. The exact
command is the existing `send` command with the ask id supplied by the daemon's hint/inbox row.

## Consequences

- `unconfirmed` stops absorbing the in-session success case; close-edge insights stop reading
  co-signed closes as unverified.
- No audit action strings change (ADR 192 §4 keeps them frozen); no new lane state; no protocol
  addition. ADR 202 owns the acceptance transition; ADR 204 only makes the existing rejection
  reason durable.
- Rejection remains reachable through the existing CLI/MCP `decline` Act and the board.
- The credential-custody gap is documented, not fixed — and is worth its own lane.

## Testing

- **Unit:** acceptance targeting refuses ambiguous lane asks; owner acceptance derives
  `verified: false`; rejection persists a trimmed, bounded note in `lane.review_sent_back`.
- **Through-DB integration** (standing rule: one per new act edge): accept by a non-owner lands
  `lane.closed` with `verified: true` / `counterpart_confirm`; reject lands `lane.review_sent_back`
  and returns the lane to `active`.
- **Exercised for real, not just tested** — the acceptance path is the thing that misrecorded, so it
  gets run against a live lane on the real daemon before the lane is submitted.

## Open follow-ons (not this lane)

- **Credential custody** — the vault makes seat forgery possible; a real barrier needs keychain or
  second-device confirmation. Own lane.
- **Board deep link** — miley, per §3.
