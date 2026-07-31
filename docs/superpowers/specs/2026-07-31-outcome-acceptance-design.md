# Outcome acceptance (not “review”) — design

- Date: 2026-07-31
- Status: approved for implementation (nick)
- ADR: [192](../../decisions/192-outcome-acceptance.md)

## Problem

ADR 169’s two-stage close named the worker’s claim `ready_for_review` and the counterpart’s
job “review.” Agents (and humans) read that as **code review before merge**. The implemented
loop is the opposite of that mental model: CI auto-merges, then a counterpart co-signs the
*close*. Catch rate stayed near zero; substance of the counterpart job was never spelled out
beyond “confirm or send back.”

## Job

A second seat judges whether the **landed outcome** matches vision/intent, is usable, respects
project principles, and (when relevant) looks/feels right. **Not** a diff/code review. **Not** a
CI substitute.

## Timing

**After merge by default.** `gates` + auto-merge remain the technical land path. Risky lanes keep
ADR 188’s peer-then-human acceptance (still post-merge). Acceptance does not block squash.

## Vocabulary

| Today (agent-facing) | New |
| --- | --- |
| state `ready_for_review` | `awaiting_acceptance` (dual-accept old value during skew) |
| `lane_ready` / `musterd lane ready` | `lane_submit` / `musterd lane submit` (+ deprecated aliases) |
| reviewer | acceptor |
| confirm / send back | accept / reject (same mechanics) |
| verified / unverified (UI) | accepted / unconfirmed |
| ask “review requested” | “acceptance requested” + checklist |

**Frozen (do not rename):** audit actions `lane.ready_for_review`, `lane.review_sent_back`,
`lane.review_peer_confirmed`; wire field `verified: boolean`; meta key `lane_review` (in-flight
asks). Insights SQL keeps filtering on the historical action strings.

## Acceptor checklist

Ask body (and worker/acceptor guidance) prompts against **lane brief + shipped artifact**:

1. **Intent** — matches title/detail?
2. **Principles** — hard rules (secrets, protocol-without-ADR, docs/code disagree, …)?
3. **Usable** — exercise the path enough to say it works?
4. **Feel** — only when UI/copy/brand is in surface; else N/A
5. **Reject** — concrete “not what we wanted / not usable yet,” not style nits

## Loop

1. Worker lands PR (CI auto-merge).
2. Worker `lane_submit` + `{pr, sha, authorized_by}` → `awaiting_acceptance`.
3. Daemon routes ask (ADR 188 ladder) with checklist body; audit still `lane.ready_for_review`.
4. Acceptor accept → `done` (accepted); reject → `active` + note; silence → owner self-close → unconfirmed.

## Non-goals

Required GitHub PR reviews; pre-merge acceptance for default lanes; musterd-as-verifier;
rewriting historical audit rows or immutable ADRs in place; hard-deleting `lane_ready` in v1.
