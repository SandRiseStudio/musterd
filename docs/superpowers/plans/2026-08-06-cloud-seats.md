# Cloud Seats Increment 1 Implementation Plan

> **For agentic workers:** Per CLAUDE.md, this repo uses musterd lanes, not subagents. Execute inline in the owning seat's session (lane 01KZAAS15M). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One persistent cloud VM seat (Fly + Tailscale) enrolled on the existing daemon — golden image + runbook, the linux wake actuator, and only the P4 remote-join fixes the dogfood proves necessary.

**Architecture:** The daemon stays on the admin's laptop (tailnet member); the VM is an ordinary client. New product code is confined to (a) a systemd sibling of the launchd wake-actuator plumbing behind the existing `serviceSupported` seam, and (b) whatever the enrollment dry-run breaks. Everything else is `deploy/cloud-seat/` artifacts + a runbook + a measurement log.

**Tech Stack:** Docker (debian-slim + node 22), Fly machines + volumes + secrets, Tailscale, systemd user units, TypeScript ESM + vitest for CLI changes.

**Spec:** `docs/superpowers/specs/2026-08-06-cloud-seats-design.md`

## Global Constraints

- **Git loop (ADR 106):** branch from fresh `origin/main` → PR → `gh pr merge --squash --auto --delete-branch`. Two product PRs: (1) systemd wake actuator, (2) deploy artifacts + runbook + ADR (+ any P4 fixes discovered, each as its own commit).
- **ADR number picked late** against `origin/main` right before the PR (collision trap — it fired mid-flight on ADR 242; check again at PR time). ADR needs an `## Observability & Evaluation` section answering Traces / Eval / Experiment (dataset + baseline), and architecture doc trees must gain a described line per new `src` file (`pnpm run format:check` enforces both).
- **vitest from repo root only:** `pnpm exec vitest run <path>`. **Never `pnpm format`** — `pnpm exec prettier --write <changed files>`. Build before typecheck.
- **Secrets discipline (spec):** the VM receives only `{MUSTERD_SERVER, team, seat, agent key}` + tailnet key + model credential, all via Fly secrets. No secret is ever written into the image, `fly.toml`, or the repo. `bootstrap.sh` must not echo secrets (`set +x` around secret use).
- **Ops steps that create cloud resources or spend money require nick at the wheel** (fly app/volume/machine creation, tailnet key mint, model credential). Show the exact command before running; flyctl MCP tools are available for driving Fly with approval.
- **v1 lifecycle semantics:** Fly auto-stop OFF (it keys on inbound traffic; the wake poller is outbound-only). Parking is explicit `fly machine stop`.

## File Structure

```
deploy/cloud-seat/Dockerfile          image: node22 + git + gh + tailscale + claude CLI + musterd
deploy/cloud-seat/fly.toml            1x shared-cpu 2GB, auto-stop off, volume mount /data
deploy/cloud-seat/bootstrap.sh        first boot: tailnet join → clone → pnpm install → enroll → wake unit
deploy/cloud-seat/README.md           the runbook (create → enroll → wake → park → move)
packages/cli/src/service/systemd.ts   buildUnit / systemctl arg builders / status parse (pure + runner-injected)
packages/cli/src/service/systemd.test.ts
packages/cli/src/service/host.ts      platform dispatch: launchd vs systemd ctx  (modify)
packages/cli/src/service/launchd.ts   serviceSupported widens for the wake actuator (modify :57)
packages/cli/src/commands/service.ts  wake path stops hard-failing on linux      (modify ~:816)
docs/perf/cloud-seat.md               eval log (wake latency, cost/day, friction list)
docs/decisions/NNN-cloud-seats.md     ADR (number picked at PR time)
docs/architecture/04-cli.md           tree line for systemd.ts                   (modify)
```

---

### Task 1: systemd wake actuator (PR 1) — pure builders, TDD

**Files:**
- Create: `packages/cli/src/service/systemd.ts`
- Test: `packages/cli/src/service/systemd.test.ts`

**Interfaces:**
- Consumes: nothing new — mirrors the shapes `host.ts` already consumes from `launchd.js` (`buildHostPlist`, `bootstrapArgs`, `printArgs`, `parseLaunchctlPrint`).
- Produces:
  ```ts
  export const HOST_UNIT_NAME = 'musterd-host.service';
  export interface UnitOpts { node: string; binJs: string; hostArgs: string[]; env?: Record<string, string>; logPath: string }
  export function buildHostUnit(o: UnitOpts): string            // INI text of the user unit
  export function unitPath(home: string): string                // ~/.config/systemd/user/musterd-host.service
  export function systemctlArgs(verb: 'enable'|'disable'|'start'|'stop'|'restart'|'is-active', unit: string): string[]
  export function parseIsActive(stdout: string): 'active' | 'inactive' | 'failed' | 'unknown'
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildHostUnit, parseIsActive, systemctlArgs, unitPath } from './systemd.js';

describe('buildHostUnit (cloud-seats inc 1) — the launchd plist’s linux sibling', () => {
  const unit = buildHostUnit({
    node: '/usr/bin/node',
    binJs: '/opt/musterd/packages/cli/dist/bin.js',
    hostArgs: ['host', '--interval', '30'],
    env: { MUSTERD_SERVER: 'http://laptop.tailnet:4849' },
    logPath: '/data/musterd-host.log',
  });

  it('runs node bin.js host with the given args', () => {
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/musterd/packages/cli/dist/bin.js host --interval 30');
  });
  it('restarts on failure and starts at boot (default.target)', () => {
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });
  it('carries env and appends logs', () => {
    expect(unit).toContain('Environment="MUSTERD_SERVER=http://laptop.tailnet:4849"');
    expect(unit).toContain('StandardOutput=append:/data/musterd-host.log');
    expect(unit).toContain('StandardError=append:/data/musterd-host.log');
  });
});

describe('systemctl plumbing', () => {
  it('targets the user manager', () => {
    expect(systemctlArgs('start', 'musterd-host.service')).toEqual(['--user', 'start', 'musterd-host.service']);
  });
  it('unitPath lands in the user unit dir', () => {
    expect(unitPath('/home/seat')).toBe('/home/seat/.config/systemd/user/musterd-host.service');
  });
  it('parseIsActive maps stdout, unknown on anything else', () => {
    expect(parseIsActive('active\n')).toBe('active');
    expect(parseIsActive('inactive\n')).toBe('inactive');
    expect(parseIsActive('failed\n')).toBe('failed');
    expect(parseIsActive('weird')).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run to verify failure:** `pnpm exec vitest run packages/cli/src/service/systemd.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — a single template string for the unit:

```
[Unit]
Description=musterd wake actuator (ADR 131)
After=network-online.target

[Service]
ExecStart=<node> <binJs> <hostArgs…>
Restart=on-failure
RestartSec=5
Environment="K=V"            (one line per env pair)
StandardOutput=append:<logPath>
StandardError=append:<logPath>

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Run to verify pass;** `pnpm exec prettier --write packages/cli/src/service/systemd.ts packages/cli/src/service/systemd.test.ts`.
- [ ] **Step 5: Commit** `feat(cli): systemd user unit builders for the wake actuator`.

### Task 2: platform dispatch (PR 1)

**Files:**
- Modify: `packages/cli/src/service/launchd.ts:57` (`serviceSupported`)
- Modify: `packages/cli/src/service/host.ts` (ctx construction picks launchd vs systemd by platform)
- Modify: `packages/cli/src/commands/service.ts` (~:816 hard-fail; the `--wake` verbs route through the platform ctx)
- Test: extend `packages/cli/src/service/host.test.ts`

**Interfaces:**
- Consumes: Task 1's exports.
- Produces: `serviceSupported(platform, service?: 'daemon'|'wake')` — daemon stays darwin-only (that seam is real: the daemon plist machinery is untouched); `wake` adds `linux`. Existing single-arg callers keep meaning `'daemon'` (optional param defaults), so no caller churn.

- [ ] **Step 1: Write failing tests** in `host.test.ts` (mirror its existing runner-injection pattern — read the file's harness first; it already fakes `launchctl` with a `Runner`):

```ts
it('on linux, wake install writes the systemd unit and enables it via the injected runner', async () => {
  // construct the ctx with platform: 'linux', tmp home; assert the unit file exists at
  // unitPath(home) and runner saw ['--user','enable', ...] then ['--user','start', ...]
});
it('on linux, wake status maps is-active output', async () => { /* runner returns 'active' → status active */ });
it('daemon service verbs still refuse on linux (the daemon seam is unchanged)', async () => {
  // serviceSupported('linux') === false; serviceSupported('linux', 'wake') === true
});
```

Write these as real tests against the actual ctx API found in `host.ts`/`host.test.ts` — the shapes above are the behavioral contract; the harness file dictates the constructor names.

- [ ] **Step 2: Verify fail. Step 3: Implement** (host.ts grows a `platform` field on its ctx; install/uninstall/start/stop/status branch to `writeFileSync(unitPath)` + `systemctl --user` args via the injected runner; `daemon-reload` after writing the unit). **Step 4: Verify pass + full CLI suite** `pnpm exec vitest run packages/cli`. **Step 5: Commit** `feat(cli): musterd service --wake works on linux via systemd user units`.
- [ ] **Step 6: PR 1.** Add the `04-cli.md` tree line for `systemd.ts`, run gates (`pnpm build && pnpm typecheck && pnpm lint && pnpm run format:check`), branch is `kimi/cloud-seats-design` → push → PR → auto-merge. (The design spec + this plan ride along in this PR.)

### Task 3: deploy artifacts (PR 2)

**Files:**
- Create: `deploy/cloud-seat/Dockerfile`, `deploy/cloud-seat/fly.toml`, `deploy/cloud-seat/bootstrap.sh`, `deploy/cloud-seat/README.md`

- [ ] **Step 1: Dockerfile**

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg openssh-client \
    && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
       > /usr/share/keyrings/tailscale-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/debian bookworm main" \
       > /etc/apt/sources.list.d/tailscale.list \
    && apt-get update && apt-get install -y tailscale \
    && (type -p wget >/dev/null || apt-get install -y wget) \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg > /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm @anthropic-ai/claude-code
WORKDIR /data
COPY bootstrap.sh /usr/local/bin/bootstrap.sh
RUN chmod +x /usr/local/bin/bootstrap.sh
CMD ["/usr/local/bin/bootstrap.sh"]
```

- [ ] **Step 2: fly.toml**

```toml
app = "musterd-seat"          # overridden per seat: musterd-seat-<name>
primary_region = "sjc"

[build]
  dockerfile = "Dockerfile"

# No [[services]]/[http_service] section at all: nothing inbound, so Fly's
# auto-stop machinery (which keys on inbound traffic) never applies. Parking
# is explicit: `fly machine stop` (spec: v1 lifecycle semantics).

[[mounts]]
  source = "seat_data"
  destination = "/data"

[env]
  # Non-secret config only. Secrets (TAILSCALE_AUTHKEY, MUSTERD_AGENT_KEY,
  # ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) go via `fly secrets set`.
  MUSTERD_TEAM = "revive"
```

- [ ] **Step 3: bootstrap.sh** — idempotent (safe on every boot):

```bash
#!/bin/bash
# Cloud seat first-boot + every-boot entrypoint (cloud-seats design, increment 1).
# Secrets arrive via Fly secrets as env: TAILSCALE_AUTHKEY (single-use), MUSTERD_SERVER,
# MUSTERD_TEAM, MUSTERD_SEAT, MUSTERD_AGENT_KEY, and a model credential.
set -euo pipefail

# 1. tailnet (idempotent: tailscale up is a no-op when already joined)
tailscaled --state=/data/tailscaled.state --socket=/run/tailscale/tailscaled.sock &
sleep 2
tailscale up --authkey="${TAILSCALE_AUTHKEY}" --hostname="musterd-${MUSTERD_SEAT}"

# 2. workspace (idempotent clone)
REPO_DIR=/data/agents-${MUSTERD_SEAT}
if [ ! -d "$REPO_DIR/.git" ]; then
  gh repo clone SandRiseStudio/musterd "$REPO_DIR"
fi
cd "$REPO_DIR" && pnpm install && pnpm build

# 3. enroll: write the binding via musterd claim (first boot creates it; later boots no-op).
#    The claim travels the existing HTTP flow — claim.pending on first contact unless the
#    ADR 146 standing-reseat policy admits a known agent silently.
export MUSTERD_SERVER MUSTERD_TEAM
node packages/cli/dist/bin.js claim "${MUSTERD_SEAT}" || true   # pending-approval exit is fine on first boot

# 4. wake actuator as a systemd user unit (Task 1/2's machinery)
node packages/cli/dist/bin.js service install --wake --interval 30

# 5. stay alive (the machine's life is this process; systemd user units ride it)
exec tail -f /data/musterd-host.log
```

- [ ] **Step 4: `bash -n bootstrap.sh` + `shellcheck` if available; `docker build deploy/cloud-seat` locally** (build must succeed; run is not expected to, off-tailnet). Note: the exact `claim` invocation and step-3 ergonomics are the P4 dry-run's subject — the script records today's best guess and the dry-run corrects it (Task 5 captures every correction).
- [ ] **Step 5: README.md runbook** — sections, each a copy-paste block: *Create* (fly app create + volume + secrets set — listing every secret name and where it comes from, incl. `claude setup-token` for Max), *First boot* (deploy, watch logs, approve the claim), *Verify* (roster shows the seat; send it an act; watch the wake), *Park/unpark* (`fly machine stop/start`), *Move a seat* (the spec §Mobility four steps, both directions, verbatim commands), *Teardown*. Every step that costs money is marked.
- [ ] **Step 6: Commit** `feat(deploy): cloud-seat image, fly config, bootstrap, runbook`.

### Task 4: P4 dry-run (ops, with nick) + fix list

This is the dogfood: provision the first real cloud seat. Every command that creates resources or spends money is shown to nick first (flyctl MCP tools available). Prereqs from nick: a Fly org, a tailnet auth key (single-use, from the Tailscale admin console), the seat name (suggest the 6th seat the laptop can't hold), and the model credential choice (API key vs `claude setup-token`).

- [ ] **Step 1:** Daemon reachability: confirm the laptop daemon is tailnet-reachable (`MUSTERD_SERVER=http://<laptop-tailnet-ip>:4849` — needs the ADR 040 bind widened off loopback with `--allowed-hosts`; the secured-bind flags exist, verify against `musterd help serve` and record the exact invocation in the runbook).
- [ ] **Step 2:** Create app + volume + secrets per the runbook, deploy, watch first boot.
- [ ] **Step 3:** Approve the claim (`musterd requests decide … --approve` or observe ADR 146 standing-reseat) — record which path fired.
- [ ] **Step 4:** Exit-criteria run: send the seat a lane (open + handoff), watch a cold wake claim → work → submit → acceptance, entirely from the VM.
- [ ] **Step 5:** Every friction point becomes either (a) a small fix committed to PR 2 with its own test, or (b) a line in the increment-2 list in the eval log. Nothing gets silently worked around.

### Task 5: eval log + ADR (PR 2 close)

**Files:**
- Create: `docs/perf/cloud-seat.md` — header (what's measured, how), then the dry-run record: wake latency samples (tailnet vs the local-seat baseline from the daemon's residency metrics), VM cost/day (Fly dashboard figure), session success, the friction list with its fix/deferred disposition.
- Create: `docs/decisions/NNN-cloud-seats.md` — decisions from the spec (one-team-one-daemon reaffirmed for VMs; ordinary-Member principle; auto-stop-off v1 economics + why; systemd seam; mobility-as-procedure; secrets discipline), `## Observability & Evaluation`: **Traces** = residency.* audit rows for the cloud seat + wake latency; **Eval** = dataset `docs/perf/cloud-seat.md`, baseline = local-seat wake latency + the ADR 242 5-seat ceiling this exists to exceed; **Experiment** = exit criteria (one lane end-to-end from the VM incl. cold wake); falsifier: if wake-over-tailnet latency or VM cost makes the cloud seat slower/costlier than just queueing for a local slot, persistent cloud seats are the wrong shape and the ephemeral increment moves up.
- [ ] **Steps:** write both → `pnpm run adr-numbers:check` + `format:check` → commit `docs: cloud-seat eval log + ADR NNN` → PR 2 → auto-merge → `lane_submit` with the PR.

## Self-Review Notes

- Spec coverage: image/bootstrap → Task 3; enrollment/credentials → Tasks 3 (bootstrap step 3) + 4; wake/systemd → Tasks 1–2; lifecycle economics → fly.toml comment + README; mobility → README §Move; eval/exit criteria → Tasks 4–5; pre-registered increments → recorded in the ADR/eval log, correctly *not* implemented.
- Deliberate deviation, stated: the spec's "product code limited to what the dogfood proves broken" — the systemd unit is built *before* the dry-run because the spec names it a known must-build; everything else waits for measured friction (Task 4 step 5 is the gate).
- Type consistency: Task 2 consumes exactly Task 1's exports; Task 3's bootstrap calls only shipped CLI verbs (`claim`, `service install --wake`).
- Honesty check: Task 2's test sketches defer constructor names to `host.test.ts`'s real harness rather than inventing them — the file dictates, the plan states the behavioral contract.

---

## Amendment 2026-09-03 — the VM is a joiner daemon, not a thin client (stanley, lane 01KZAAS15M)

The federation arc (ADRs 325–376, landed 2026-08-25 → 2026-09-03) changed what "a second
machine" is: a machine daemon that replicates, with the laptop as hub. The spec's spine 1 ("the
daemon stays on the admin's machine; the VM is a client") was the ADR 039 answer and is superseded
by ADR 325 — the VM runs its own daemon and enrolls (ADR 328), the laptop is the hub because the
team was created there (ADR 376). Spine 2–4 stand. What this changes in the tasks:

- **Tasks 1–2 (systemd wake actuator, `serviceSupported` widening) are dropped.** A Fly machine
  is a container whose entrypoint is the supervisor; there is no systemd to write a unit for, and
  `musterd host` runs on linux unchanged (it is a poll loop that spawns `claude -p`). No product
  code is built ahead of the dry-run — the spec's own rule, now without the exception.
- **Task 3 is rewritten as landed**: `deploy/cloud-seat/{Dockerfile,fly.toml,entrypoint.sh,README.md}`.
  The entrypoint brings up tailscaled (kernel networking, as the broadcast image proved), a
  loopback daemon with SQLite on the volume, the team, `musterd node join` against the hub
  (resolved through tailscaled; the laptop's `tailscale serve` forwards 4849), the seat's
  workspace, `residency on`, then `exec musterd host`. Every step is idempotent.
- **Task 4 (the dry-run) gains the three pre-registered two-machine experiments** — ADR 365
  §O&E, ADR 366 §Experiment, ADR 371 §O&E — as exit criteria beside the lane-end-to-end run.
  Their first live measurement is the point of this machine.
- **Task 5's ADR** records the joiner-not-client decision, the v1 lifecycle economics, and
  inherits ADR 376 §4's open question (hub relocation) with the measurement that decides it.

The "P4 remote-join fixes" in the lane title were built by the arc (ADRs 328, 331, 358, 360); the
dry-run measures what is left. Known unknowns are listed in the runbook's last section.
