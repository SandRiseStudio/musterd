# Tailscale + Aperture paved road — Increment 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this
> plan task-by-task in your own musterd seat. Repository rule 8 forbids writing subagents; if the work
> leaves this seat, hand it to another seat with a musterd `handoff` Act.

**Goal:** Ship an optional, read-only `musterd integration doctor` that independently verifies a
selected Tailscale Team transport and a selected Aperture configuration, while publishing the honest
reference architecture and never implying device management, sandbox enforcement, or active Aperture
enforcement.

**Architecture:** The protocol package owns zod schemas for every third-party input and the stable JSON
report. The CLI has two pure/injected inspectors—Tailscale reachability and Aperture configuration—and
one renderer/command. The command opts integrations in explicitly with `--tailscale` and
`--aperture <url>`; an absent integration is `off`, not failed. Increment 1 reads local CLI state and
HTTP endpoints only. It never writes Tailscale state, Aperture configuration, musterd configuration,
or Team state.

**Tech stack:** TypeScript ESM, zod, Node HTTP/fetch, `ws`, JSON5 (HuJSON/JWCC parsing), vitest,
picocolors through the existing `theme` seam.

**Approved design:**
`docs/superpowers/specs/2026-09-02-tailscale-aperture-paved-road-design.md`

## Non-negotiable boundaries

- Both integrations remain optional and independently selectable.
- The doctor is read-only. It may execute only `tailscale version`, `tailscale status --json`, and
  `tailscale serve status --json`; it may make `GET`/upgrade probes. It must never call `tailscale up`,
  `tailscale serve`, an Aperture mutation endpoint, or a musterd write endpoint.
- A green Aperture inspection means **configuration ready**, while enforcement remains `off` in this
  increment. Only the later governed-launch increment can report `required`.
- A missing unselected integration is healthy `off`. A selected integration with a failed or
  unparseable check exits 1. Argument/usage errors exit 2.
- The Tailscale transport check runs on the daemon host. It verifies the exact path Members will use,
  not merely that a policy file or plist contains plausible text.
- No prompt, response, provider credential, Tailscale credential, musterd credential, hook secret, or
  complete Aperture config is printed, logged, or returned in JSON.
- Do not add persistent state, protocol frames, server routes, storage, federation behavior, model
  launching, device lifecycle, sandboxing, drift repair, or API application.
- Every external JSON/HuJSON value is parsed by a schema exported from `@musterd/protocol`.
- Protocol schema and runtime-dependency changes require the ADR in Task 1. The musterd wire remains
  `musterd/0.3`; these are local diagnostic/vendor schemas, not new frames.
- Every commit ends with:

  ```text
  Co-authored-by: big-body <big-body@revive.musterd>
  ```

## Command and report contract

```text
musterd integration doctor [--tailscale] [--aperture <https-url>] [--json]
```

- No selection: render both sections as `off`, explain the flags, exit 0.
- `--tailscale`: inspect local Tailscale and the configured musterd daemon.
- `--aperture <url>`: GET `<url>/api/config` through the caller's existing Tailscale identity. Require
  `https:` except loopback test URLs. Never accept a bearer-token flag.
- Both flags: run both inspectors and preserve two separate sections.
- JSON is exactly `IntegrationDoctorReportSchema`; no ANSI or commentary goes to stdout.

Stable check keys:

| Integration | Keys, in order |
| --- | --- |
| Tailscale | `tailscale-installed`, `tailnet-up`, `daemon-secured-bind`, `tailscale-serve`, `daemon-host-gate`, `daemon-http`, `daemon-websocket` |
| Aperture | `aperture-config-api`, `aperture-retention`, `aperture-providers`, `aperture-grants`, `aperture-quotas`, `aperture-identities` |

The human no-color green combined frame is:

```text
integration doctor

TAILSCALE TRANSPORT — verified
✓ tailscale installed — 1.80.0
✓ tailnet up — daemon.tailnet.ts.net · 100.64.0.10
✓ daemon secured bind — loopback behind tailscale serve
✓ tailscale serve — tcp/4849 → 127.0.0.1:4849
✓ daemon Host gate — daemon.tailnet.ts.net and 100.64.0.10 accepted
✓ daemon HTTP — /health reachable over the tailnet
✓ daemon WebSocket — /ws upgrade reachable over the tailnet

APERTURE MODEL ENFORCEMENT — off (configuration ready)
✓ Aperture config API — aperture.tailnet.ts.net · hash 8d14c921
✓ body retention — zero; captures and tools purged
✓ providers — anthropic (2 models)
✓ default grants — exact Member workload identities; no wildcard source
✓ quotas — every model grant has a rejecting, defined bucket
✓ identity prerequisites — persistent Member tags are exact and non-admin

LIMITS
· configuration and reachability evidence only; Aperture enforcement remains off
· no device management, sandbox enforcement, or unrelated-harness coverage
```

Never expose the full Aperture hash; eight lowercase hex characters are enough for diagnostic
correlation. If an upstream hash is not hexadecimal, print `present` rather than echoing it.

## File map

| File | Responsibility |
| --- | --- |
| `docs/decisions/NNN-optional-tailscale-aperture-doctor.md` | CLI/schema/dependency/security decision |
| `packages/protocol/src/integrations.ts` | vendor input and stable doctor report schemas |
| `packages/protocol/src/integrations.test.ts` | strict boundary and secret-free report tests |
| `packages/protocol/src/index.ts` | export the integration schemas |
| `packages/cli/src/process.ts` | injected synchronous command runner shared by inspectors |
| `packages/cli/src/integrations/tailscale.ts` | pure parsing plus empirical Tailscale/daemon checks |
| `packages/cli/src/integrations/tailscale.test.ts` | parser, dependency ladder, and read-only command tests |
| `packages/cli/src/integrations/aperture.ts` | HuJSON parse, redaction, and configuration checks |
| `packages/cli/src/integrations/aperture.test.ts` | retention/grant/quota/identity negative matrix |
| `packages/cli/src/integrations/report.ts` | report composition and exact terminal rendering |
| `packages/cli/src/integrations/report.test.ts` | four optional combinations and exact no-color frame |
| `packages/cli/src/commands/integration.ts` | argv, URL validation, inspector orchestration, exit codes |
| `packages/cli/src/commands/integration.test.ts` | injected command tests; proves no writes/network escape |
| `packages/cli/src/broadcast/hosted.ts` | consume extracted process/Tailscale primitives |
| `packages/cli/src/broadcast/hosted.test.ts` | retain hosted-stream behavior after extraction |
| `packages/cli/src/commands/stream.ts` | import the extracted Tailscale primitives |
| `packages/cli/src/commands/stream.test.ts` | retain stream-doctor behavior |
| `packages/cli/src/bin.ts` | dispatch `integration` |
| `packages/cli/src/help/catalog.ts` | discoverable command contract |
| `packages/cli/package.json`, `pnpm-lock.yaml` | direct `json5@2.2.3` runtime dependency |
| `docs/architecture/04-cli.md` | current implementation and drift-checked file tree |
| `docs/design/figma-brief-terminal.md` | lock the `cmd/integration-doctor` frame |
| `docs/guides/cross-network-overlay.md` | replace manual verification with the optional doctor path |
| `docs/design/security.md` | link the model-governance boundary; do not duplicate it |
| approved design spec | mark Increment 1 implemented and link ADR/command after landing |

---

### Task 1: Reserve and publish the ADR before authoring it

**Files:**
- Create: `docs/decisions/NNN-optional-tailscale-aperture-doctor.md`
- Modify: approved design spec

- [ ] **Step 1: Confirm the Lane and clean scope**

Run:

```bash
musterd inbox --limit 10
musterd lane list
git status --short --branch
```

Expected: Lane `01M1J1F48R76ANNR2FD5TTTYDP` is owned by `big-body`; only this branch's plan/spec and
the user's pre-existing `.cursor/rules/` and `.musterd/` entries are present.

- [ ] **Step 2: Take the next ADR number**

Run `pnpm adr:next`. Record the returned number as `NNN`. Do not infer it from the repository.

- [ ] **Step 3: Publish the claim immediately, before writing the ADR**

Run the required pre-push smoke gates:

```bash
pnpm typecheck
pnpm format:check
git push -u origin docs/tailscale-aperture-paved-road
```

Open a draft PR whose title is `feat(cli): add optional Tailscale and Aperture doctor`, then enable
squash auto-merge only after implementation is complete—not while the PR is draft.

- [ ] **Step 4: Write the ADR with the repository skeleton**

The Decision must lock:

1. the exact command/flags and exit codes above;
2. explicit selection and independent optionality;
3. no durable `partial` state—Aperture remains `off` in Increment 1;
4. empirical, read-only checks and the prohibited mutation list;
5. protocol-owned vendor/report zod schemas without a wire-version bump;
6. `json5@2.2.3` as a direct CLI runtime dependency because Aperture returns HuJSON/JWCC; rejected
   alternatives are unsafe comment stripping, treating HuJSON as JSON, or asking Aperture to mutate or
   validate a candidate merely to read current posture;
7. exact model-only claim limits and the device-management/sandbox non-claims;
8. no stored verification timestamp in Increment 1—JSON carries `observed_at`, and drift history waits
   for the later activation/storage design.

Add `Refs ADR-NNN` to the approved spec's status line without rewriting the frozen decisions.

- [ ] **Step 5: Commit and push the ADR claim**

```bash
git add docs/decisions/NNN-optional-tailscale-aperture-doctor.md docs/superpowers/specs/2026-09-02-tailscale-aperture-paved-road-design.md
git commit -m "docs: decide the optional integration doctor

Refs ADR-NNN

Co-authored-by: big-body <big-body@revive.musterd>"
git push
```

---

### Task 2: Add protocol boundary and JSON report schemas

**Files:**
- Create: `packages/protocol/src/integrations.ts`
- Create: `packages/protocol/src/integrations.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**

```ts
export const TailscaleStatusSchema: z.ZodType<...>;
export const TailscaleServeStatusSchema: z.ZodType<...>;
export const ApertureConfigResponseSchema: z.ZodType<...>;
export const ApertureConfigSchema: z.ZodType<...>;
export const IntegrationCheckSchema: z.ZodType<...>;
export const IntegrationSectionSchema: z.ZodType<...>;
export const IntegrationDoctorReportSchema: z.ZodType<...>;
export type ApertureConfig = z.infer<typeof ApertureConfigSchema>;
export type IntegrationCheck = z.infer<typeof IntegrationCheckSchema>;
export type IntegrationSection = z.infer<typeof IntegrationSectionSchema>;
export type IntegrationDoctorReport = z.infer<typeof IntegrationDoctorReportSchema>;
```

Use these exact report fields:

```ts
const IntegrationCheckSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  state: z.enum(['ok', 'fail', 'skip']),
  detail: z.string().min(1).optional(),
  fix: z.string().min(1).optional(),
}).strict();

const IntegrationSectionSchema = z.object({
  integration: z.enum(['tailscale', 'aperture']),
  selected: z.boolean(),
  posture: z.enum(['off', 'verified', 'ready', 'blocked']),
  checks: z.array(IntegrationCheckSchema),
}).strict();

const IntegrationDoctorReportSchema = z.object({
  version: z.literal(1),
  ok: z.boolean(),
  observed_at: z.number().int().nonnegative(),
  tailscale: IntegrationSectionSchema,
  aperture: IntegrationSectionSchema,
  limits: z.array(z.string().min(1)).length(2),
}).strict().superRefine(/* section integration tags and ok === no selected fail */);
```

Vendor schemas must be `.passthrough()` at vendor-owned levels but type every field the inspector
reads. In particular, type provider `baseurl`/`models`, grant `src`/`app`, Aperture capability
`role`/`models`/`quotas`, quota `bucket`/`capacity`/`rate`/`on_exceed`, and
`database.retention.duration`/`purge`/`require_export`. Do not model unused provider secrets.

- [ ] **Step 1: Write failing schema tests**

Cover valid current Tailscale status/serve JSON; valid Aperture API wrapper + configuration; rejection
of wrong types for every read field; strict rejection of extra musterd-report keys; failure when report
`ok` contradicts a selected failed check; and successful redacted report round-trip. Assert the report
fixture contains none of `api_key`, `authorization`, `prompt`, `response`, `mskey_`, or `msgr_`.

- [ ] **Step 2: Run the focused test and observe failure**

```bash
pnpm --filter @musterd/protocol test -- src/integrations.test.ts
```

Expected: FAIL because `./integrations.js` does not exist.

- [ ] **Step 3: Implement schemas and barrel export**

Add `export * from './integrations.js';` to `index.ts`. Keep `PROTOCOL_VERSION` unchanged.

- [ ] **Step 4: Verify the protocol package**

```bash
pnpm --filter @musterd/protocol test
pnpm --filter @musterd/protocol build
```

Expected: PASS; protocol coverage remains at least 95% lines.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/integrations.ts packages/protocol/src/integrations.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): define integration doctor boundaries

Refs ADR-NNN

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 3: Extract shared process and Tailscale primitives without behavior change

**Files:**
- Create: `packages/cli/src/process.ts`
- Create: `packages/cli/src/integrations/tailscale.ts`
- Create: `packages/cli/src/integrations/tailscale.test.ts`
- Modify: `packages/cli/src/broadcast/hosted.ts`
- Modify: `packages/cli/src/broadcast/hosted.test.ts`
- Modify: `packages/cli/src/commands/stream.ts`
- Modify: `packages/cli/src/commands/stream.test.ts`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**

```ts
// process.ts
export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => ExecResult;
export const realExec: Exec;

// integrations/tailscale.ts
export interface TailnetSelf { dnsName: string; ip4: string | null; running: boolean }
export type UpgradeVerdict = 'allowed' | 'rejected' | 'unreachable';
export function parseTailscaleSelf(json: string): TailnetSelf | null;
export function serveForwardsPort(json: string, port: number): boolean;
export function probeUpgradeHost(origin: { hostname: string; port: number }, host: string, timeoutMs?: number): Promise<UpgradeVerdict>;
```

- [ ] **Step 1: Move existing parser/probe tests first**

Move the `parseTailscaleSelf`, `serveForwardsPort`, and `probeUpgradeHost` cases from
`broadcast/hosted.test.ts` into `integrations/tailscale.test.ts`. Add malformed-but-valid JSON cases
that fail the protocol schemas. Change imports before implementations so the test fails on the new
module.

- [ ] **Step 2: Run focused tests and observe failure**

```bash
pnpm --filter @musterd/cli test -- src/integrations/tailscale.test.ts src/broadcast/hosted.test.ts src/commands/stream.test.ts
```

- [ ] **Step 3: Extract, parse through protocol, and rewire**

Move `ExecResult`, `Exec`, and `realExec` verbatim to `process.ts`. Move the three Tailscale helpers to
`integrations/tailscale.ts`, replacing casts with `TailscaleStatusSchema.safeParse(JSON.parse(...))`
and `TailscaleServeStatusSchema.safeParse(...)`. Rewire hosted streaming and tests to the new modules.
Do not re-export from the old broadcast module.

- [ ] **Step 4: Update the architecture file tree**

Add described entries for `process.ts`, `integrations/tailscale.ts`, and its test. Rewrite the
`broadcast/hosted.ts` description so it owns only hosted-stream checks/Fly parsers.

- [ ] **Step 5: Verify no behavior regression and commit**

```bash
pnpm --filter @musterd/cli test -- src/integrations/tailscale.test.ts src/broadcast/hosted.test.ts src/commands/stream.test.ts
git add packages/cli/src/process.ts packages/cli/src/integrations/tailscale.ts packages/cli/src/integrations/tailscale.test.ts packages/cli/src/broadcast/hosted.ts packages/cli/src/broadcast/hosted.test.ts packages/cli/src/commands/stream.ts packages/cli/src/commands/stream.test.ts docs/architecture/04-cli.md
git commit -m "refactor(cli): share empirical Tailscale inspection

Refs ADR-NNN

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 4: Build the pure Aperture posture analyzer

**Files:**
- Create: `packages/cli/src/integrations/aperture.ts`
- Create: `packages/cli/src/integrations/aperture.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**

```ts
export interface ApertureObservation {
  host: string;
  hash: string;
  config: ApertureConfig;
}
export function parseApertureResponse(host: string, body: unknown): ApertureObservation;
export function inspectApertureConfig(observation: ApertureObservation): IntegrationCheck[];
export function safeConfigHash(hash: string): string;
```

- [ ] **Step 1: Add the direct dependency**

Run `pnpm --filter @musterd/cli add json5@2.2.3`. Confirm only the CLI manifest and lockfile change.

- [ ] **Step 2: Write the failing security matrix**

Fixtures contain no real credentials. Cover:

1. exact zero retention: duration `0`, both `captures` and `tools` purged, `require_export:false`;
2. every one-field retention drift fails;
3. at least one provider, non-empty HTTPS `baseurl`, non-empty model list;
4. `src:["*"]`, wildcard Member tags, group/user sources, shared-tag-only sources, mixed broad+exact
   sources, and agent `role:"admin"` fail;
5. only sorted `tag:musterd-agent,tag:musterd-member-<lowercase opaque id>` sources pass identity
   prerequisites;
6. at least one model capability exists;
7. every model capability has at least one quota reference; every referenced bucket exists;
8. every referenced definition has positive dollar `capacity`, dollar/unit `rate`, and
   `on_exceed:"reject"`;
9. connector/tool capabilities are ignored by the model checker and remain covered by the rendered
   non-claim;
10. malformed API JSON, malformed HuJSON, wrong vendor shapes, and non-2xx are failures without
    echoing bodies;
11. `safeConfigHash` emits eight lowercase hex characters or `present` only.

- [ ] **Step 3: Run and observe failure**

```bash
pnpm --filter @musterd/cli test -- src/integrations/aperture.test.ts
```

- [ ] **Step 4: Implement pure parsing and checks**

Use `JSON5.parse(response.config)` and immediately pass it through `ApertureConfigSchema`. Return only
counts, provider names/model counts, stable check keys, and redacted hash evidence. Never retain or
render the raw body after analysis. A check failure always contains a concrete manual repair but no
mutation code.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @musterd/cli test -- src/integrations/aperture.test.ts
git add packages/cli/package.json pnpm-lock.yaml packages/cli/src/integrations/aperture.ts packages/cli/src/integrations/aperture.test.ts docs/architecture/04-cli.md
git commit -m "feat(cli): inspect Aperture configuration safely

Refs ADR-NNN

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 5: Build the Tailscale transport inspector

**Files:**
- Modify: `packages/cli/src/integrations/tailscale.ts`
- Modify: `packages/cli/src/integrations/tailscale.test.ts`

**Interfaces:**

```ts
export interface TailscaleDoctorDeps {
  exec: Exec;
  server: string;
  fetch: typeof globalThis.fetch;
  probeUpgrade: typeof probeUpgradeHost;
}
export async function inspectTailscaleTransport(deps: TailscaleDoctorDeps): Promise<IntegrationCheck[]>;
```

- [ ] **Step 1: Write the failing dependency-ladder tests**

Assert the seven stable keys and these cases: fully green; missing CLI skips dependants; tailnet down;
malformed status; daemon configured to `0.0.0.0` or a non-loopback plaintext address; missing serve
forward; DNS and IPv4 Host-gate rejection independently; tailnet HTTP failure; tailnet WebSocket
failure; non-default daemon port; IPv6-only self with a useful explicit failure; all subprocess calls
belong to the three-command read-only allowlist.

- [ ] **Step 2: Run and observe failure**

```bash
pnpm --filter @musterd/cli test -- src/integrations/tailscale.test.ts
```

- [ ] **Step 3: Implement the empirical ladder**

Resolve the configured daemon URL. Increment 1 supports the safe local pattern—loopback daemon behind
`tailscale serve`—and fails with guidance to run the doctor on the daemon host for a remote configured
origin. Probe the loopback Host gate for both MagicDNS and IPv4, then probe `/health` and `/ws` through
the actual tailnet address. Use three-second timeouts. Do not shell through a string.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @musterd/cli test -- src/integrations/tailscale.test.ts src/broadcast/hosted.test.ts src/commands/stream.test.ts
git add packages/cli/src/integrations/tailscale.ts packages/cli/src/integrations/tailscale.test.ts
git commit -m "feat(cli): verify Tailscale Team transport read-only

Refs ADR-NNN

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 6: Compose and render the four optional combinations

**Files:**
- Create: `packages/cli/src/integrations/report.ts`
- Create: `packages/cli/src/integrations/report.test.ts`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**

```ts
export const INTEGRATION_LIMITS: readonly [string, string];
export function composeIntegrationReport(input: {
  observedAt: number;
  tailscaleSelected: boolean;
  tailscaleChecks: IntegrationCheck[];
  apertureSelected: boolean;
  apertureChecks: IntegrationCheck[];
}): IntegrationDoctorReport;
export function renderIntegrationReport(report: IntegrationDoctorReport): string;
```

- [ ] **Step 1: Write failing composition/render tests**

Cover neither, Tailscale-only, Aperture-only, both; selected failures; skipped dependants; schema parse
of every composed report; exact no-color combined frame from this plan; and these posture rules:

- unselected → `off`, empty checks;
- selected green Tailscale → `verified`;
- selected green Aperture → `ready` while its heading still says enforcement `off`;
- any selected failure → `blocked`, top-level `ok:false`.

- [ ] **Step 2: Run and observe failure**

```bash
pnpm --filter @musterd/cli test -- src/integrations/report.test.ts
```

- [ ] **Step 3: Implement through `theme`/`sym` only**

Do not introduce colors or glyphs outside `brand.md` §2 and the existing renderer. Parse the final
object with `IntegrationDoctorReportSchema.parse` before returning it.

- [ ] **Step 4: Update the CLI architecture tree and commit**

```bash
pnpm --filter @musterd/cli test -- src/integrations/report.test.ts
git add packages/cli/src/integrations/report.ts packages/cli/src/integrations/report.test.ts docs/architecture/04-cli.md
git commit -m "feat(cli): compose optional integration posture

Refs ADR-NNN

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 7: Wire `musterd integration doctor`

**Files:**
- Create: `packages/cli/src/commands/integration.ts`
- Create: `packages/cli/src/commands/integration.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/help/catalog.ts`
- Modify: `docs/architecture/04-cli.md`

**Interfaces:**

```ts
export interface IntegrationCommandDeps {
  exec?: Exec;
  fetch?: typeof globalThis.fetch;
  probeUpgrade?: typeof probeUpgradeHost;
  server?: string;
  now?: () => number;
  out?: (text: string) => void;
}
export async function integrationCommand(parsed: Parsed, deps?: IntegrationCommandDeps): Promise<number>;
```

- [ ] **Step 1: Write failing command tests**

Test usage/unknown subcommand (2); neither selected (0, no subprocess/fetch); each single selection;
both; selected failure (1); exact JSON schema and zero ANSI under `--json`; HTTPS Aperture URL required
except `localhost`, `127.0.0.1`, and `[::1]`; `GET /api/config` exactly once with a three-second abort;
non-2xx/body/schema failures redact response text; and a spy proves no subprocess other than the three
Tailscale reads and no HTTP method other than GET.

- [ ] **Step 2: Run and observe failure**

```bash
pnpm --filter @musterd/cli test -- src/commands/integration.test.ts
```

- [ ] **Step 3: Implement the command**

Use `loadConfig().server` when `deps.server` is absent. `--tailscale` is already a boolean parser flag
only after adding it to `BOOLEAN_FLAGS` in `packages/cli/src/args.ts`; add an argv parser regression
case in `packages/cli/src/args.test.ts`. Parse `--aperture` as a string and reject a valueless flag.
Run selected inspectors concurrently, compose once, and return 0/1 from the parsed report.

- [ ] **Step 4: Wire dispatch and help**

Import and dispatch `integration` in `bin.ts`. Add a non-primary Setup command with the exact signature,
read-only language, optionality, and non-claims. Examples show all four combinations.

- [ ] **Step 5: Update current architecture**

Add the command/test to the drift-checked file tree and a `musterd integration doctor` section with
inputs, checks, exit codes, read-only behavior, and JSON schema name. Link the ADR; do not duplicate the
full approved design.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @musterd/cli test -- src/args.test.ts src/commands/integration.test.ts src/integrations
git add packages/cli/src/args.ts packages/cli/src/args.test.ts packages/cli/src/bin.ts packages/cli/src/help/catalog.ts packages/cli/src/commands/integration.ts packages/cli/src/commands/integration.test.ts docs/architecture/04-cli.md
git commit -m "feat(cli): add the optional integration doctor

Refs ADR-NNN

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 8: Lock the terminal frame and publish the reference path

**Files:**
- Modify: `docs/design/figma-brief-terminal.md`
- Modify: `docs/guides/cross-network-overlay.md`
- Modify: `docs/design/security.md`
- Modify: approved design spec

- [ ] **Step 1: Update the terminal contract**

Add `cmd/integration-doctor` with the exact frame in this plan, failure variants, and exit-code notes.
Use the Figma skill before editing the actual Figma file, then update the existing `musterd / Terminal
UX` Commands page rather than creating a second file. Capture the frame URL/id in the brief. If Figma
access is unavailable, stop this task and report the blocker; do not silently claim snapshot match.

- [ ] **Step 2: Update the operator guide**

Keep the existing manual Topology B recipe. Add the optional command after manual setup and explain
that it verifies only Tailscale Team transport. Add the Aperture-only and combined invocations as links
to the approved design, not a duplicated configuration tutorial.

- [ ] **Step 3: Update security by linking**

Add one paragraph: Aperture is optional model governance for supported musterd-launched Surfaces; it
does not manage devices, sandbox Members, or cover unrelated harnesses. Link the approved design and
ADR for the details.

- [ ] **Step 4: Mark only Increment 1 implemented**

In the approved design, set Increment 1 to implemented with the command and ADR. Leave Increments 2–4
and deferred tool enforcement unchanged.

- [ ] **Step 5: Run doc/format checks and commit**

```bash
pnpm vocab:check
pnpm format:check
git add docs/design/figma-brief-terminal.md docs/guides/cross-network-overlay.md docs/design/security.md docs/superpowers/specs/2026-09-02-tailscale-aperture-paved-road-design.md
git commit -m "docs: publish the paved-road verification path

Refs ADR-NNN

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 9: Prove the Increment, self-review, and land it

**Files:** all files in this plan

- [ ] **Step 1: Run focused security falsifiers**

```bash
pnpm --filter @musterd/protocol test -- src/integrations.test.ts
pnpm --filter @musterd/cli test -- src/integrations src/commands/integration.test.ts src/broadcast/hosted.test.ts src/commands/stream.test.ts
```

Expected: PASS. Review test output for accidental live subprocess/network access; all tests use injected
fakes or loopback servers.

- [ ] **Step 2: Run the focused package checks and required fast local gates**

```bash
pnpm --filter @musterd/cli test
pnpm typecheck
pnpm format:check
```

Expected: all green. Do not run the full recursive suite locally to pre-verify CI; the `gates` workflow
is authoritative for `pnpm -r build && pnpm -r lint && pnpm test` and therefore for the repository's
`any "done"` rule.

- [ ] **Step 3: Dogfood read-only combinations**

After `pnpm --filter @musterd/cli build`, run from source:

```bash
node packages/cli/dist/bin.js integration doctor
node packages/cli/dist/bin.js integration doctor --json
node packages/cli/dist/bin.js integration doctor --tailscale
```

Do not point `--aperture` at production or another person's instance. A real Aperture check requires a
separately authorized isolated endpoint; without one, rely on the hermetic tests and record that the
live path was not exercised.

- [ ] **Step 4: Perform the security self-review**

Inspect the complete diff for: forbidden verbs/methods; raw response/config printing; credential-like
fixtures; false `required` wording; accidental device/sandbox claims; schema bypasses; unbounded
timeouts; non-injected tests; protocol version drift; and architecture tree drift.

- [ ] **Step 5: Push, mark ready, and enable squash auto-merge**

```bash
git diff --check
git status --short
git push
gh pr ready
gh pr merge --squash --auto --delete-branch
```

Do not poll. Let required `gates` CI land the PR.

- [ ] **Step 6: Verify the authoritative run when notified**

Run `gh pr checks` once after the merge/notification. The required `gates` check must be green; if it
is red, return to the failing task and do not claim the Increment complete.

- [ ] **Step 7: After merge, submit for outcome acceptance**

Use `musterd lane submit` for Lane `01M1J1F48R76ANNR2FD5TTTYDP` with the landed PR, SHA, and
`authorized_by:nick`. Prefer counterpart acceptance. Then clear the local branch exactly as the repo
contract requires:

```bash
git fetch origin main --prune
git switch --detach origin/main
git branch -D docs/tailscale-aperture-paved-road
```

Finally run `musterd inbox --limit 10` and send a concise `status_update` Act with the landed outcome
and the explicit statement that no external configuration was changed.
