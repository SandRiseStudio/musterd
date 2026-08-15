# Dogfood OTEL Service Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repository forbids write-capable subagent execution, so implementation stays inline in the owning seat.

**Goal:** Let a macOS operator durably configure the dogfood daemon's standard OTLP endpoint through `musterd service install`.

**Architecture:** Extend the existing daemon-environment resolver with one daemon-only CLI input. The generated LaunchAgent plist remains the persistence layer, and its current read-back behavior preserves the endpoint across later installs.

**Tech Stack:** TypeScript, Vitest, macOS LaunchAgent plist generation, existing CLI argument parser.

## Global Constraints

- Product telemetry stays off by default; no endpoint is selected automatically.
- Use only the standard `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable.
- The flag applies only to the daemon LaunchAgent, not `--live`, `--wake`, `--auto`, `--guardian`, or `--sweep`.
- No protocol schema or runtime dependency changes.
- Never print arbitrary inherited daemon environment values.
- Follow red-green-refactor: every production behavior starts with a failing test.

---

### Task 1: Persist a daemon OTLP endpoint through service install

**Files:**
- Modify: `packages/cli/src/commands/service.allowedhosts.test.ts`
- Modify: `packages/cli/src/commands/service.ts`
- Modify: `packages/cli/src/help/catalog.ts`
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/design/observability.md`

**Interfaces:**
- Consumes: `parsePlistEnvironment(xml)` and the existing daemon plist environment read-back.
- Produces: `resolveDaemonEnv(existingPlist, allowedHosts, otlpEndpoint): Record<string, string>` and the daemon-only `--otlp-endpoint <url>` installer option.

- [ ] **Step 1: Add failing resolver tests**

Extend `describe('resolveDaemonEnv')` with assertions equivalent to:

```ts
it('writes, preserves, replaces, and clears the standard OTLP endpoint', () => {
  expect(resolveDaemonEnv(null, undefined, 'http://127.0.0.1:4318')).toEqual({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
  });
  expect(resolveDaemonEnv(withOtlp, undefined, undefined)).toEqual({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
  });
  expect(resolveDaemonEnv(withOtlp, undefined, 'http://127.0.0.1:14318')).toEqual({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:14318',
  });
  expect(resolveDaemonEnv(withOtlp, undefined, '')).toEqual({});
});
```

Keep the cases independently named if that makes failures clearer.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @musterd/cli test -- src/commands/service.allowedhosts.test.ts
```

Expected: TypeScript/Vitest failure because `resolveDaemonEnv` does not accept or apply the OTLP endpoint argument.

- [ ] **Step 3: Implement minimal resolver support**

Change the resolver signature and apply the explicit override after preserving prior non-`PATH` keys:

```ts
export function resolveDaemonEnv(
  existingPlist: string | null,
  allowedHosts: string | undefined,
  otlpEndpoint: string | undefined,
): Record<string, string> {
  // existing preservation and allowed-host normalization
  if (otlpEndpoint !== undefined) {
    const endpoint = otlpEndpoint.trim();
    if (endpoint) env['OTEL_EXPORTER_OTLP_ENDPOINT'] = endpoint;
    else delete env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  }
  return env;
}
```

Pass `flagStr(parsed.flags, 'otlp-endpoint')` from `serviceCommand`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all focused tests pass.

- [ ] **Step 5: Add failing command-boundary tests**

Add end-to-end tests proving:

```ts
await run(['install', '--otlp-endpoint', 'http://127.0.0.1:4318'], up);
expect(parsePlistEnvironment(readFileSync(ctx.plistPath, 'utf8'))?.OTEL_EXPORTER_OTLP_ENDPOINT)
  .toBe('http://127.0.0.1:4318');
```

Then assert a retargeted command rejects the daemon-only flag:

```ts
await expect(
  serviceCommand(parseArgs(['status', '--live', '--otlp-endpoint', 'http://127.0.0.1:4318']), deps),
).rejects.toThrow(/--otlp-endpoint.*daemon/i);
```

- [ ] **Step 6: Run the focused test and verify RED**

Run the command from Step 2. Expected: the plist assertion or daemon-only validation assertion fails because command wiring is incomplete.

- [ ] **Step 7: Wire and constrain the CLI option**

Add `--otlp-endpoint <url>` to the usage string. Before dispatching retargeted service branches, reject its presence when any of `live`, `wake`, `auto`, `guardian`, or `sweep` is true with a `CliError` exit code 2. Do not add endpoint output to the success renderer.

- [ ] **Step 8: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all focused tests pass.

- [ ] **Step 9: Update the shipped documentation**

In `docs/architecture/04-cli.md`, add the installer flag and state that it writes the standard OTLP endpoint to the daemon plist, preserves it on reinstall, and accepts an empty value to clear it. In `docs/design/observability.md`, point dogfood operators at:

```bash
musterd service install --otlp-endpoint http://127.0.0.1:4318
```

Update `packages/cli/src/help/catalog.ts` so the service help names the daemon-only option and includes the dogfood install example.

- [ ] **Step 10: Run focused tests and fast gates**

Run:

```bash
pnpm --filter @musterd/cli test -- src/commands/service.allowedhosts.test.ts
pnpm typecheck
pnpm format:check
```

Expected: all commands exit 0.

- [ ] **Step 11: Commit the implementation**

```bash
git add packages/cli/src/commands/service.allowedhosts.test.ts packages/cli/src/commands/service.ts packages/cli/src/help/catalog.ts docs/architecture/04-cli.md docs/design/observability.md
git commit -m "feat: persist dogfood OTEL endpoint in daemon service" -m "Co-authored-by: gptbot <gptbot@revive.musterd>"
```
