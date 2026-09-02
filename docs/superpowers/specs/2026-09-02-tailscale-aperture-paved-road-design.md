# Tailscale + Aperture paved road — optional transport and governed model access

**Date:** 2026-09-02

**Seed:** `01M0ZXBSKGMADATTQJ13PWZ6SA` — “Paved roads - aperture (tailscale)”

**Status:** approved exploration design; implementation requires increment-specific ADRs and plans

**Security boundary:** product architecture only; no active scanning, production access, or
infrastructure mutation was performed

## 1. Outcome

musterd offers an optional, composable paved road for two separate needs:

1. **Private Team transport through Tailscale.** Members on different machines reach the Team daemon
   through a private overlay. This packages and verifies the already-shipped Topology B rather than
   changing musterd's transport model.
2. **Governed model access through Aperture.** Model requests made by supported harnesses while acting
   as a musterd Member pass through Aperture, where identity, routing, quotas, and pre-spend refusal are
   enforced with task-aware authorization supplied by musterd.

The integrations are independent. A Team may use neither, either, or both:

| Tailscale transport | Aperture enforcement | Result |
| --- | --- | --- |
| off | off | Current local-first musterd |
| on | off | Private cross-network Team |
| off | on | Local Team with governed model access |
| on | on | Full paved-road reference stack |

Neither integration becomes a prerequisite for musterd. Existing local Teams, CLI flows, MCP Surfaces,
and direct provider configurations continue to work unchanged when the integrations are off.

## 2. Product thesis

Tailscale and musterd solve different identity problems:

- Tailscale proves the network identity of a user or workload.
- musterd knows the durable Member, the machine node authorized to speak for that Member, the current
  Presence, the active Lane, the directed Act that caused a wake, and the Team's Role ceilings.
- Aperture sits in front of model providers and can refuse a request before provider spend.

The useful combination is not “put musterd behind a VPN” or “add another model proxy.” It is:

> musterd supplies trustworthy Member and work context; Tailscale carries trustworthy workload
> identity; Aperture is the optional runtime enforcement point for model access.

This follows the six production rules captured at Tailscale Up: use a workload identity per agent;
authorize every model/tool action rather than reading intent out of the prompt; bind authorization to
the system's real task state; default deny; refuse before spend; and log an actionable reason.

## 3. Claims and non-claims

When Aperture enforcement is `required`, musterd may claim:

> Model traffic performed by an attested, participating agent Member through a supported,
> musterd-launched Surface is governed by the Team's Aperture policy.

musterd must not claim:

- that all AI traffic on the device is governed;
- that a user cannot launch an unrelated harness outside musterd;
- that local shell, filesystem, browser, or independently configured MCP access is enforced;
- that Tailscale network membership alone authorizes a Member or an action;
- that prompt inspection proves task authorization;
- that Aperture replaces musterd credentials, grants, Presence leases, node admission, or audit.

Device management and sandbox enforcement remain out of scope. Tool enforcement through Aperture is a
separate future design (§12), not an implied property of the model-only first release.

## 4. Adoption states

Each integration has its own explicit state.

### 4.1 Tailscale transport

- `off`: current loopback/local deployment or another operator-managed topology.
- `verified`: the selected overlay address, secured-bind acknowledgement, allowed Host values, HTTP
  reachability, and WebSocket upgrade have passed verification.
- `drifted`: the last verified configuration no longer matches observed state.

`verified` describes evidence at a time, not ownership. musterd does not claim to operate the tailnet.

### 4.2 Aperture model enforcement

- `off`: musterd makes no governed-model claim.
- `required`: every in-scope agent Member must attach through a governed launch. An unmanaged launch
  cannot establish a compliant Presence for that Member.
- `drifted`: policy, identity, retention, or reachability no longer matches the required posture. New
  governed launches stop, and requests whose policy cannot be verified fail closed.

There is no durable `partial` or `pilot` security state. Setup may validate Members one at a time, but
musterd continues to report enforcement as `off` until every in-scope Member verifies and activation
commits atomically. Failed activation changes nothing. Rollback explicitly returns to `off` and records
the actor and reason.

For the first release, **in scope means every active agent Member in the Team**. Human Members are not
model workloads, and no agent Member may be excluded as an exception while the Team reports
`required`. A Team containing an agent Member whose harness is unsupported cannot activate
`required`; it remains `off` until that harness gains a verified governed launcher or the Member is no
longer active. This deliberately chooses an honest binary claim over a configurable coverage cohort.

## 5. Identity model

### 5.1 Invariants

1. One governed model request resolves to exactly one Team, one agent Member, and one authorized
   musterd machine node.
2. Network identity is obtained from Tailscale's control plane, never from a client-supplied Member
   header.
3. The durable authority edge is the musterd Member-to-machine-node binding. Presence heartbeats,
   connection ids, and wake leases are local runtime facts and are not identity roots.
4. A human who starts a governed session is recorded as `authorized_by`; the agent Member does not
   impersonate the human.
5. Renaming a Member does not silently create a new workload identity or transfer the old identity.

Federation is moving while this design is written. Implementations must preserve the invariant that a
machine node may speak only for Members bound to it. They must not depend on the current physical table
or replication shape. Every ingress that accepts a claimed Member fact must eventually enforce the
binding; claim-time enforcement alone is not a complete boundary.

### 5.2 Tailscale workload identity

Each governed agent Member gets, on each authorized musterd machine node:

- a persistent embedded Tailscale node used only for Aperture traffic;
- a shared classification tag such as `tag:musterd-agent`;
- a stable opaque Member tag such as `tag:musterd-member-a7f3c2`;
- a readable device hostname for operator diagnosis; and
- a local mapping from Tailscale device id and opaque tag to Team, Member, and machine node.

The opaque tag is the policy identity. The hostname is presentation only. The generated tailnet policy
defines every Member tag explicitly and grants it only the ability needed to reach Aperture. Aperture
grants match the exact sorted tag identity. Wildcard sources such as `src: ["*"]` are forbidden in the
generated steady-state policy.

The bridge state is persistent per Member per machine node and stored with mode `0600`. Losing a
Presence stops the bridge process but does not destroy its identity. Explicit Member unbinding or
removal from that machine revokes the Tailscale device and then removes the local state. Partial failure
leaves the credential quarantined and reported; it never reports successful revocation before both
sides agree.

Human Members use their existing user-authenticated Tailscale identity for Team transport. The agent
workload tags above apply to non-human workload nodes only; they are not applied to a person's device.

## 6. Governed launch

The first release supports sessions launched through musterd. It does not attempt to infer trustworthy
Member identity for an arbitrary already-running harness.

The launch flow is:

1. A human or authorized wake path asks musterd to launch a supported harness as one agent Member.
2. musterd verifies that the local machine node is authorized for the Member and creates a bounded
   launch authorization.
3. musterd starts or selects the Member's persistent local Tailscale bridge.
4. musterd launches the harness with an Aperture base URL pointing at that bridge and with direct
   provider credentials absent from the generated environment.
5. The harness establishes its ordinary musterd Presence through the MCP adapter. The Presence carries
   an attested governed-launch posture and correlation id.
6. Aperture authenticates the bridge's Tailscale identity and evaluates its exact grant.
7. Before forwarding each request, Aperture invokes the musterd authorization endpoint.
8. musterd resolves the trusted device identity to the Member and machine node, evaluates current work
   authorization and policy, and returns an allow/refuse decision with a structured reason.
9. Aperture applies its native quota and provider routing, then sends the request upstream only if both
   systems allow it.
10. Metadata after the response reconciles the model and actual cost against the launch authorization.

Claude Code and Codex are the initial compatibility targets because Aperture documents both and both
can be launched with an alternate model endpoint. Supporting another harness requires an explicit
adapter test; “OpenAI-compatible” is not sufficient evidence for a compliant launch.

## 7. Authorization model

Every request must pass four independent checks.

### 7.1 Identity

- The Tailscale device id and exact tag identity resolve to one registered Member workload.
- The Member is still bound to the authenticated musterd machine node.
- The Member and Team are active, and the credential/device has not been revoked.

### 7.2 Launch

- A live, musterd-created launch authorization exists for this Member and machine node.
- The launch belongs to the attested Presence/session correlation.
- Its issuer, expiry, and revocation state are valid.
- A client-provided session id may aid correlation but is never sufficient authorization.

### 7.3 Work context

At least one server-verified context must be live:

- an active Lane owned by the Member;
- an unresolved directed Act that legitimately woke the Member, bounded by the Act's resolution and
  the wake authorization's expiry; or
- a short-lived, low-spend orientation allowance created by a human-started launch so the Member can
  inspect its Inbox/status and select a Lane.

The request is authorized from these facts, not from prompt text. The orientation allowance is a
bootstrap exception, not a background budget: it expires by time and quota and cannot be refreshed by
the agent itself.

### 7.4 Policy

- The requested provider/model is inside the Team ceiling.
- Any Role or Member override may narrow, never widen, the Team ceiling.
- Aperture's native per-identity quota has remaining capacity.
- An emergency exception, if present, is human-admin issued, Member- and model-scoped, short-lived,
  reasoned, and audited.

musterd owns whether the work is authorized. Aperture owns provider routing, upstream credentials, and
spend enforcement. musterd must not reproduce a general model proxy.

## 8. Data handling and audit

The paved-road default is metadata-only:

- Aperture uses zero body retention for prompt and response bodies.
- musterd verifies and reports the observed retention posture but never exposes a control that enables
  content capture.
- A Team that independently enables Aperture content retention is reported as noncompliant with this
  paved road; musterd does not silently reset external policy.
- Authorization requests and audit rows contain identity, model, work-context references, decision,
  reason code, timing, quota/cost metadata, and a correlation id—never prompt or response content.
- Provider keys, Tailscale credentials, bridge state, musterd credentials, and hook secrets never enter
  logs, telemetry, Team Acts, generated tracked files, or command output after initial issuance.
- Routine allow/refuse decisions are audit records, not Team Acts. Only actionable posture changes or
  explicit human requests use the Team's communication layer.

Every refusal returns an actionable, non-secret reason such as:

- `denied_no_work_context`
- `denied_model_outside_ceiling`
- `denied_member_node_mismatch`
- `denied_launch_expired`
- `denied_quota_exhausted`
- `denied_policy_unreachable`

An allow decision similarly records its basis, such as `allowed_active_lane` or
`allowed_directed_act`. User-facing copy may explain the next action, but the stable reason code drives
automation and tests.

## 9. Failure behavior

| Failure | Required behavior |
| --- | --- |
| musterd policy endpoint unavailable | Refuse before provider spend; never fall back to static grant |
| Member/machine binding missing or stale | Refuse; stop or quarantine the local bridge |
| Launch authorization expired/revoked | Refuse and tell the operator how to relaunch |
| Work context ended | Refuse and name the valid next action |
| Model outside ceiling | Refuse; never silently substitute a model |
| Aperture quota exhausted | Refuse with the caller's reset/remaining information only |
| Aperture policy or retention drift | Block new launches; fail closed where current authorization cannot be proved |
| Unmanaged Surface on a `required` Team | Refuse a compliant Presence; explain the governed launch path |
| External revocation succeeds but local cleanup fails | Quarantine local state; report cleanup debt without restoring access |
| Local cleanup succeeds but external revocation fails | Keep a tombstone and retry/report; never reuse the identity |

The human-admin emergency bypass is the only fail-open mechanism. It is explicit, narrow, expiring, and
audited. Network failure, stale configuration, or operator silence never creates a bypass.

## 10. Operator experience

### 10.1 Read-only posture

One umbrella posture view reports both integrations without conflating them. It includes:

- observed state and last verification time;
- the exact Member coverage for Aperture;
- configuration drift and orphaned identities;
- body-retention posture;
- daemon bind, allowed Host values, and WebSocket verification;
- blockers to activation; and
- the limits of musterd's claim.

Mixed states are stated literally. For example, “Tailscale transport verified; Aperture enforcement
off” is valid. “Aperture configured for 2/5 agent Members” is setup progress, not partial enforcement.

### 10.2 Generate before apply

The first provisioning surface generates deterministic, reviewable configuration for:

- Tailscale tags, ownership, and least-privilege reachability;
- Aperture exact grants, providers/model ceilings, quotas, hook, and zero-retention posture;
- Member/device mappings; and
- daemon bind and allowed Host settings where Tailscale transport is selected.

Generated tracked artifacts contain no secrets. The operator applies the configuration manually and
runs verification.

### 10.3 Optional API application

API-driven provisioning is a later opt-in. It must:

1. use the narrowest available Tailscale and Aperture credentials;
2. show the complete proposed diff;
3. identify destructive/revocation effects separately;
4. require an explicit human-admin confirmation;
5. record the actor, scope, result, and external object ids without secrets; and
6. verify the resulting state instead of trusting API success.

Drift detection remains report-only. musterd never silently repairs an external control plane.

Exact CLI wording and layout are not decided here. Any new command must follow the CLI design brief and
Figma terminal contract; this spec defines behavior, not an unreviewed terminal surface.

## 11. Delivery increments

### Increment 1 — reference architecture and read-only doctor

- Publish the four optional combinations and the honest security claim.
- Inspect daemon/Tailscale reachability, secured-bind and Host posture, Aperture reachability,
  retention, providers, default grants, quotas, and identity prerequisites.
- Make no external changes.

### Increment 2 — configuration generator

- Generate secret-free tailnet policy, Aperture configuration, Member identity mappings, and daemon
  settings.
- Validate exact identities, deny-by-default grants, zero retention, and least privilege.
- Leave application to the operator.

### Increment 3 — governed model launcher

- Manage persistent per-Member-per-machine bridge identities.
- Launch Claude Code and Codex through Aperture.
- Add work-context authorization, fail-closed decisions, metadata-only audit correlation, and native
  Aperture quotas.
- Activate the Team transactionally from `off` to `required` only after every in-scope Member passes.

### Increment 4 — optional API provisioning

- Apply reviewed Tailscale and Aperture changes through narrow credentials.
- Verify after apply and expose drift without auto-repair.

Every increment that changes protocol schemas, storage, federation, authorization, dependencies, or CLI
output needs its own ADR before implementation. Build order remains protocol → server → CLI → MCP, and
the relevant package acceptance gates remain authoritative.

## 12. Deferred tool enforcement

Aperture can also proxy MCP servers and HTTP connectors, but that is a separate authorization boundary
and a separate design. A future increment may:

- derive the connect-time tool list from the Team ceiling and narrower Role/Member policy;
- omit forbidden tools entirely rather than loading and later refusing them;
- authorize each proxied tool action;
- bind resource arguments to the Member's real Lane and declared resource scopes; and
- inject upstream credentials only after authorization.

It must still state that local shell, filesystem, browser, and independently configured MCP servers are
outside musterd's enforcement. Built-in Tailnet and Tailscale SSH connectors require their own threat
model and cannot inherit approval from the model-routing design.

## 13. Acceptance criteria

The first complete model-governance release is accepted only when:

1. Two agent Members on one host appear as distinct trusted Aperture principals.
2. The same Member on an unauthorized machine node cannot reuse the identity.
3. Each allowed request correlates across musterd authorization, Aperture metadata, provider/model, and
   actual cost without storing content.
4. A valid identity with no valid work context is refused before provider spend.
5. A revoked Member/device/launch is refused on the next request.
6. Policy-endpoint failure never degrades to a static or cached allow beyond an already-decided request.
7. Claude Code and Codex both pass the same authorization matrix.
8. Direct/local musterd behaves unchanged when both integrations are off.
9. Tailscale-only, Aperture-only, and combined deployments verify independently.
10. No prompt, response, provider key, bridge credential, musterd credential, or hook secret appears in
    logs, telemetry, audit details, Team Acts, generated tracked files, or error output.
11. Aperture body retention is zero and a drifted retention setting prevents compliance activation.
12. Rollback to `off` is explicit, audited, and leaves no falsely compliant Presence.

Verification must include unit policy matrices, integration tests with synthetic credentials and data,
negative identity/revocation/drift cases, and real supported-harness compatibility tests against an
isolated staging environment. Active testing of Tailscale or Aperture infrastructure requires a
separate authorized high-stakes audit Lane; this design grants no such authority.

## 14. Success measures

- **Setup success:** a new operator can generate and verify the reference stack without copying a
  provider key into a Member's Workspace.
- **Attribution:** 100% of governed model requests resolve to one Member and machine node; unknown or
  ambiguous identity is a refusal, not an “other” bucket.
- **Pre-spend enforcement:** denied requests produce zero provider calls.
- **Audit completeness:** every governed request has exactly one correlated decision and terminal
  outcome or an explicit incomplete marker.
- **Privacy:** zero prompt/response bodies retained by the paved-road configuration.
- **Optionality:** all four integration combinations pass their own acceptance path, and disabling the
  integrations restores current behavior without data migration or hidden dependency.
- **Honesty:** product surfaces never describe device-wide or sandbox enforcement.

## 15. Sources and constraints

Repository constraints:

- `docs/design/security.md`
- `docs/design/deployment-topology.md`
- `docs/guides/cross-network-overlay.md`
- `docs/architecture/00-overview.md`
- `docs/architecture/03-server.md`
- `docs/architecture/04-cli.md`
- `docs/architecture/05-mcp.md`
- ADRs 039, 040, 131, 325, 328, 331, 344, 350, 353, and 355
- Stanley's 2026-09-02 federation notes on Presence replication and Member-to-machine binding

External product facts were checked against Tailscale's current documentation on 2026-09-02:

- [Aperture overview and identity model](https://tailscale.com/docs/aperture/how-aperture-works)
- [Aperture grants and deny-by-default semantics](https://tailscale.com/docs/aperture/how-grants-work)
- [Aperture bridges / `ts-unplug`](https://tailscale.com/docs/aperture/connect-outside-tailnet)
- [Aperture usage observation and zero body retention](https://tailscale.com/docs/aperture/observe-and-export)
- [Tailscale tag ownership](https://tailscale.com/docs/features/tags)
- [Tailscale OAuth client constraints](https://tailscale.com/kb/1215/control-data-planes)

These are external, evolving capabilities. Each implementation increment must revalidate the specific
Aperture and Tailscale behavior it depends on rather than treating this exploration date as a version
pin.
