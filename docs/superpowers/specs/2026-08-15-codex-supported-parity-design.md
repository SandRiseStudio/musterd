# Codex Supported-Parity Evidence Design

## Goal

Make the owner-gated Codex CLI acceptance prove the current binding contract and complete a repeatable, honest acceptance record for every coordination outcome Codex desktop supports.

## Scope

This work covers two independent Surfaces.

1. **Codex CLI**: prove real project-MCP join, directed inbox drain, and exact thread resume against an isolated Team.
2. **Codex desktop**: record observed evidence for project trust, MCP load, seat join, delivery and drain, duplicate-seat handling, workspace isolation, reload/reconnect, model/build attestation, and durable delivery after a manual reopen.

Desktop daemon wake/resume is intentionally out of scope. It requires a stable, supported API that can target an exact desktop task, observe its lifecycle, and safely resume it. The desktop acceptance must state that this capability is unsupported rather than infer it from MCP reload or the CLI backend.

## Current finding

The approved real CLI acceptance run reaches a stale assertion before it can check delivery or resume. It expects `binding.member === 'Ada'`. The binding contract deliberately removed `member`; a named seat is represented by `binding.claim = { mode: 'seat', name: 'Ada' }` and `bindingSeat()` derives the seat from that policy. The assertion is therefore incompatible with the current protocol and cannot be a proof of join.

## Design

### CLI acceptance: verify observable truth, not a local legacy field

The acceptance fixture keeps its isolated daemon, temporary Git workspace, project-local MCP configuration, and two explicit spend gates.

After Codex completes `team_join` and `team_inbox_check`, the test will assert all of the following:

- the binding parses through `BindingSchema` and has the declared fixed seat claim `{ mode: 'seat', name: 'Ada' }`;
- the isolated daemon reports an online Presence for Member `Ada` on the `codex` Surface;
- the directed Act is absent from Ada's unread inbox after the in-session drain;
- `codex exec resume --json <first-thread-id>` exits successfully and reports the same thread identity.

The server Presence is the join proof. The local claim policy only proves that the test fixture remained bound to the intended Member; it is not used as evidence of occupancy. The test remains owner-gated and creates no production Team, workspace, or credential.

### Desktop parity: prove every supported coordination outcome

The desktop matrix remains the source of record for manual acceptance. It will be updated with the precise Codex desktop version, date, operator, Team, workspace, and daemon build used for each execution.

Each supported row has a binary recorded result plus evidence:

| Outcome | Evidence |
| --- | --- |
| Trusted project and MCP load | Project-local `musterd` server is enabled in `/mcp`. |
| Join and claim | The expected Member has a new `codex` Presence in `team_status`; no untracked Member appears. |
| Directed delivery and drain | A second Surface sends an Act; desktop `team_inbox_check` renders it once and the next check is empty. |
| Duplicate-seat protection | A second desktop session for the same seat supersedes the first; the roster never retains two autonomous Presences. |
| Project isolation | A different unbound project does not acquire the original workspace's Team identity or credentials. |
| Reload/reconnect | `/mcp reload` reconnects to the expected Team and preserves normal coordination after rejoin. |
| Model/build attestation | `team_status` presents the actual model/build state or a skew warning; it never reports a made-up attestation. |
| Offline manual resume | A directed Act persists while desktop is closed and is available only after the operator reopens the project. |

The matrix will record `unsupported` rather than `pending` only when a capability is conclusively unavailable by product boundary. It retains `pending` for unexecuted observable checks, so a missing run cannot read as parity.

### Capability boundary

The shared outcome is reliable coordination, not identical product controls. Codex CLI may participate in the host residency backend after its capability probe and real acceptance pass. Codex desktop has project MCP configuration, explicit reload, and normal durable coordination; it does not expose a verified daemon control plane in this design. No desktop host registration, synthetic wake, or task-targeting claim is added.

## Failure handling

- A CLI assertion failure leaves the acceptance result failed and names the observed layer: binding fixture, MCP join, inbox delivery/drain, or resume identity.
- A desktop matrix failure records the actual app version and evidence, leaves the affected outcome unsupported/unproven, and does not weaken credential isolation or bypass trust.
- Any discovery of a supported desktop lifecycle API pauses implementation for a new ADR; it changes the explicit ADR 216 boundary.

## Verification

1. Run the repaired acceptance without both gates and confirm the paid turn remains skipped.
2. With the owner's two gates, run `pnpm test:codex-cli-real` and require all three tests to pass.
3. Execute every desktop matrix row in the real desktop app, recording versioned evidence and keeping desktop wake marked unsupported.
4. Run the fast repository gates before opening the PR; CI remains the full-suite authority.

## Constraints

- No protocol schema changes and no new runtime dependency.
- Parse fixture binding data through the existing protocol schema.
- Do not log credentials, grants, transcripts, or raw environment values.
- Keep real Codex execution double-gated and isolated from the shared daemon and Team.
