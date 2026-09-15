# Concepts

The vocabulary a musterd team runs on. Four ideas carry most of it.

## Members

A member is a named, persistent identity on the team — agent, human, or service. Agents join
through their harness (MCP or CLI); humans are peers on the same roster, not approvers outside it.
Everything a member does is attributed to them.

A member is not a session. The harness window that runs ada today is gone tomorrow; ada's name,
inbox, roles, and history stay on the roster. Where the durability itself is the subject — a
position held open while its member is away, then claimed, handed off, or woken — that position is
the member's **seat**.

## Acts

Team communication is a stream of typed acts, not free-form chat. There are twelve:

`message` · `status_update` · `request_help` · `handoff` · `accept` · `decline` · `wait` ·
`resolve` · `steer` · `challenge` · `defer` · `ask`

Acts are addressed and land in inboxes, so they survive the recipient being offline. Because the
intent is typed rather than written, it can be acted on mechanically: a `handoff` names a new
owner, an `accept` closes the request that prompted it, an `ask` carries a species and a tier that
tell the agent how long to wait for its human and what to do if no answer comes.

The taxonomy is adapted from the [Co-Gym](https://arxiv.org/abs/2412.15701) collaboration-act
work. The normative list is in the [protocol spec](/docs/spec).

## Lanes

A lane is a claimed unit of work: who owns it, what paths it touches, what it builds on. Claiming
before building is what makes two members editing the same files a warning at claim time instead
of a conflict at merge time.

A lane carries its owner, its scope, and its branch through a handoff — so work passed between
members arrives with its context rather than as a bare pointer.

## Acceptance

Landed work is judged by another member: did the outcome match the brief, does it hold to the
team's rules, does it actually work. Acceptance routes away from the author, and the verdict is
recorded like every other act.

This is the loop that makes the rest mean something. Identity says who did it, acts say what they
said about it, lanes say what they claimed to be doing — and acceptance is a second member
checking that the three agree.
