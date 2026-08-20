import * as p from '@clack/prompts';
import {
  BINDING_DIR,
  BINDING_FILE,
  WORKSPACE_SPEC_FILE,
  BindingSchema,
  WorkspaceSpecSchema,
  type Binding,
  type WorkspaceSpec,
  type WorktreeProvisioning,
} from '@musterd/protocol';
import { join } from 'node:path';
import pc from 'picocolors';
import { flagStr, type Parsed } from '../args.js';
import { loadBinding, loadWorkspace } from '../config.js';
import { CliError } from '../errors.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { loadProvisioning, readProvisionManifest, saveProvisioning } from '../onboard/manifest.js';
import { defaultHarnessContext, type HarnessContext } from '../onboard/reconcile/context.js';
import {
  inspectHarnesses,
  reconcileHarnesses,
  type FragmentInspection,
  type HarnessInspection,
  type ReconcileResult,
} from '../onboard/reconcile/engine.js';
import { registryOrder, type HarnessAdapter } from '../onboard/reconcile/fragments.js';
import { theme } from '../render/theme.js';

/**
 * `musterd harness` — the desired-set front door (ADR 281/282/286).
 *
 * - `configure` is the ONE desired-set editor and the ONE legacy converter: a human confirms the
 *   complete harness set for this worktree, the strict v2 identity/manifest state is saved, and
 *   only then does reconciliation run — with `legacyRepair: true`, the sole caller allowed to.
 * - `status [--json]` is read-only (`inspectHarnesses` — no file saves, no mutation lease). Exit 0
 *   only when every desired fragment is usable and every undesired owned contribution is released;
 *   pending unavailability still exits 0 (a selection survives the harness not being installed).
 */
export async function harnessCommand(parsed: Parsed, deps?: HarnessDeps): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'configure') return configureCommand(parsed, deps);
  if (sub === 'status') return statusCommand(parsed, deps);
  throw new CliError(
    'usage: musterd harness configure | musterd harness status [--json]  ·  musterd help harness',
    2,
  );
}

/** Test seams: everything ambient the command would otherwise reach for. */
export interface HarnessDeps {
  ctx?: HarnessContext;
  registry?: HarnessAdapter[];
  /** Non-interactive selection (tests; also `--select a,b` headless use). */
  select?: string[];
  confirm?: boolean;
  out?: (line: string) => void;
}

interface LocalState {
  ctx: HarnessContext;
  workspace: ReturnType<typeof loadWorkspace>;
  binding: ReturnType<typeof loadBinding>;
  provisioning: ReturnType<typeof loadProvisioning>;
}

function localState(deps?: HarnessDeps): LocalState {
  const cwd = process.cwd();
  const workspace = loadWorkspace(cwd);
  const team =
    workspace.kind === 'valid'
      ? workspace.value.team
      : isRecord(workspace.kind === 'legacy' ? workspace.value : null)
        ? String((workspace as { value: Record<string, unknown> }).value['team'] ?? '')
        : '';
  const ctx = deps?.ctx ?? defaultHarnessContext(cwd, process.env, { team });
  return {
    ctx,
    workspace,
    binding: loadBinding(cwd),
    provisioning: loadProvisioning(cwd, ctx.fs),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const LEGACY_LINE =
  'this worktree is pre-ADR-281 (version-1 identity) — run musterd harness configure to convert it';

// ── status ────────────────────────────────────────────────────────────────────────────────────────

async function statusCommand(parsed: Parsed, deps?: HarnessDeps): Promise<number> {
  const out = deps?.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const { ctx, workspace, provisioning } = localState(deps);
  if (workspace.kind === 'legacy' || provisioning.kind === 'legacy') {
    out(`${theme.err('✗')} ${LEGACY_LINE}`);
    return 1;
  }
  if (workspace.kind === 'invalid' || provisioning.kind === 'invalid') {
    out(
      `${theme.err('✗')} this worktree's local musterd state is unreadable — repair it or re-run ` +
        '`musterd harness configure`',
    );
    return 1;
  }
  if (provisioning.kind === 'missing') {
    out(
      `${theme.err('✗')} no harness selection here — run musterd harness configure ` +
        '(or musterd init for a fresh folder)',
    );
    return 1;
  }
  const desired = provisioning.value.desired;
  const inspections = await inspectHarnesses(ctx, desired, {
    ...(deps?.registry ? { registry: deps.registry } : {}),
  });
  if (parsed.flags['json'] === true) {
    out(JSON.stringify({ desired, harnesses: inspections.map(jsonInspection) }));
    return statusExitCode(inspections);
  }
  for (const h of inspections) {
    out(harnessHeadline(h));
    for (const f of h.fragments) {
      out(`  ${f.fragmentKey.padEnd(13)} ${f.scope.padEnd(12)} ${verdictOf(f)}`);
    }
  }
  return statusExitCode(inspections);
}

function harnessHeadline(h: HarnessInspection): string {
  const selection = h.desired ? 'selected' : 'not selected';
  const avail =
    h.harness === 'musterd'
      ? 'native (no external footprint)'
      : h.harness === 'musterd-core'
        ? 'internal guidance'
        : h.availability.available
          ? 'available'
          : `pending (${h.availability.detail ?? 'not installed here'})`;
  return `${h.harness.padEnd(13)} ${selection} · ${avail}`;
}

/** The exact verdict strings the terminal brief pins (docs/design/figma-brief-terminal.md §8-10). */
export function verdictOf(f: FragmentInspection): string {
  if (f.journal === 'invalid') return `${theme.err('✗')} container unreadable`;
  if (f.journal === 'pending') return 'journal pending — re-run musterd wire';
  if (f.lock === 'held') return '⏳ busy — another reconciler holds this';
  if (f.lock === 'invalid') return `${theme.err('✗')} container unreadable`;
  switch (f.planned) {
    case 'unchanged':
      return f.desired ? `${theme.ok('✓')} in place` : `${theme.ok('✓')} released`;
    case 'satisfied-unmanaged':
      return `${theme.ok('✓')} satisfied (unmanaged)`;
    case 'applied':
      return '→ needs wire';
    case 'conflict':
      return f.observation === 'owned-drifted'
        ? `${theme.err('✗')} drifted — evidence retained`
        : `${theme.err('✗')} conflict — not musterd's to overwrite`;
    case 'release-blocked':
      return `${theme.err('✗')} release blocked — drifted while deselected`;
    case 'repair-needed':
      return `${theme.err('✗')} legacy launch marker — run musterd harness configure`;
    case 'invalid-container':
      return `${theme.err('✗')} container unreadable`;
    default:
      return f.planned;
  }
}

function fragmentHealthy(f: FragmentInspection): boolean {
  if (f.journal !== 'none' || f.lock === 'invalid') return false;
  if (f.desired) {
    return f.planned === 'unchanged' || f.planned === 'satisfied-unmanaged';
  }
  // Undesired: an owned contribution must be RELEASED — any pending release/remove/blocked fails.
  return f.planned === 'unchanged' && !f.ownedHere;
}

function statusExitCode(inspections: HarnessInspection[]): number {
  // Pending unavailability exits zero: the selection survives; there is nothing to repair here.
  const healthy = inspections.every(
    (h) =>
      (!h.desired && h.fragments.length === 0) ||
      !h.availability.available ||
      h.fragments.every(fragmentHealthy),
  );
  return healthy ? 0 : 1;
}

function jsonInspection(h: HarnessInspection): Record<string, unknown> {
  return {
    harness: h.harness,
    surface: h.surface,
    desired: h.desired,
    available: h.availability.available,
    ...(h.availability.detail !== undefined ? { detail: h.availability.detail } : {}),
    fragments: h.fragments.map((f) => ({
      fragmentKey: f.fragmentKey,
      scope: f.scope,
      desired: f.desired,
      observation: f.observation,
      ownedHere: f.ownedHere,
      plan: f.plan,
      planned: f.planned,
      journal: f.journal,
      lock: f.lock,
    })),
  };
}

// ── configure ─────────────────────────────────────────────────────────────────────────────────────

async function configureCommand(parsed: Parsed, deps?: HarnessDeps): Promise<number> {
  const out = deps?.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const { ctx, workspace, binding, provisioning } = localState(deps);

  if (workspace.kind === 'missing' && binding.kind === 'missing') {
    throw new CliError(
      'no musterd workspace here — run `musterd init` to set one up (configure edits an existing ' +
        "worktree's harness selection).",
      2,
    );
  }
  if (workspace.kind === 'invalid' || binding.kind === 'invalid') {
    throw new CliError(
      "this worktree's identity files are unreadable — repair `.musterd/workspace.json` / " +
        '`binding.json` by hand or re-run `musterd init`.',
      1,
    );
  }

  const registry = registryOrder(deps?.registry ?? harnessAdapters());
  const availability = new Map<string, { available: boolean; detail?: string }>();
  for (const adapter of registry) availability.set(adapter.id, await adapter.availability(ctx));

  const converting = workspace.kind === 'legacy' || binding.kind === 'legacy';
  const current =
    provisioning.kind === 'valid'
      ? provisioning.value.desired
      : // Legacy manifest: preselect ONLY the corresponding former harness as a suggestion.
        legacySuggestion(ctx);

  const selected =
    deps?.select ??
    flagStr(parsed.flags, 'select')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ??
    (await promptSelection(registry, availability, current));
  if (selected === null) {
    out(pc.dim('no changes made'));
    return 0;
  }
  const desired = registry.map((a) => a.id).filter((id) => selected.includes(id));

  if (converting) {
    const confirmed =
      deps?.confirm ??
      (await confirmPrompt(
        `Convert this pre-ADR-281 worktree and set its complete harness set to ` +
          `${desired.length > 0 ? desired.join(', ') : '(none)'}?`,
      ));
    if (!confirmed) {
      out(pc.dim('no changes made'));
      return 0;
    }
  }

  // ── Save desire BEFORE reconciliation (ADR 282): a stop right after this leaves honest intent. ──
  const converted = saveLocalState(ctx, { workspace, binding, provisioning }, desired);
  out(`${theme.ok('✓')} desired harnesses: ${desired.length > 0 ? desired.join(', ') : '(none)'}`);

  const report = await reconcileHarnesses(ctx, desired, {
    legacyRepair: true, // the ONE caller allowed to: the human just confirmed the complete set
    ...(deps?.registry ? { registry: deps.registry } : {}),
  });
  for (const r of report.results) out(renderResult(r));
  if (converted) out(pc.dim('converted the version-1 identity/manifest to version 2'));
  if (report.ok) out(`${theme.ok('✓')} worktree configured — musterd wire repairs it any time`);
  return report.ok ? 0 : 1;
}

function renderResult(r: ReconcileResult): string {
  const label = `${r.harness}${r.resourceKey ? '' : ''}  ${r.action === 'none' ? '' : `(${r.action}) `}`;
  const verdictText =
    r.result === 'applied'
      ? `${theme.ok('✓')} applied`
      : r.result === 'unchanged'
        ? `${theme.ok('✓')} unchanged`
        : r.result === 'satisfied-unmanaged'
          ? `${theme.ok('✓')} satisfied (unmanaged)`
          : r.result === 'pending'
            ? `· pending (${r.detail ?? 'not installed here'})`
            : `${theme.err('✗')} ${r.result}${r.detail ? ` — ${r.detail}` : ''}`;
  return `  ${label}${verdictText}`;
}

/** The v1 manifest's harness (or nothing) — the ONLY preselection a legacy folder gets. */
function legacySuggestion(ctx: HarnessContext): string[] {
  const manifest = readProvisionManifest(ctx.worktreeRoot);
  return manifest?.harness ? [manifest.harness] : [];
}

async function promptSelection(
  registry: HarnessAdapter[],
  availability: Map<string, { available: boolean; detail?: string }>,
  current: string[],
): Promise<string[] | null> {
  const picked = await p.multiselect({
    message: "Which harnesses should launch this worktree's member?",
    options: registry.map((a) => {
      const avail = availability.get(a.id);
      return {
        value: a.id,
        label: a.id === 'musterd' ? 'musterd (native host)' : a.id,
        ...(avail && !avail.available
          ? { hint: `pending — ${avail.detail ?? 'not installed here'}` }
          : {}),
      };
    }),
    initialValues: current,
    required: false,
  });
  if (p.isCancel(picked)) return null;
  return picked as string[];
}

async function confirmPrompt(message: string): Promise<boolean> {
  const answer = await p.confirm({ message, initialValue: true });
  return !p.isCancel(answer) && answer === true;
}

/**
 * Persist the strict v2 identity + manifest for the confirmed selection. Converts a RECOGNIZED
 * legacy identity (drop `surface`, add `version: 2`, keep the fields the v2 schemas carry) and a
 * legacy v1 manifest (retain `role` as `profile` — name-only v1 records never become ownership
 * evidence). Returns whether a conversion happened.
 */
function saveLocalState(
  ctx: HarnessContext,
  state: Pick<LocalState, 'workspace' | 'binding' | 'provisioning'>,
  desired: string[],
): boolean {
  let converted = false;
  const { fs, worktreeRoot, clock } = ctx;

  if (state.workspace.kind === 'legacy') {
    const legacy = state.workspace.value as Record<string, unknown>;
    const spec: WorkspaceSpec = WorkspaceSpecSchema.parse({
      version: 2,
      server: legacy['server'],
      team: legacy['team'],
      ...(legacy['claim'] !== undefined ? { claim: legacy['claim'] } : {}),
    });
    fs.mkdirp(join(worktreeRoot, BINDING_DIR));
    fs.writeFile(
      join(worktreeRoot, BINDING_DIR, WORKSPACE_SPEC_FILE),
      `${JSON.stringify(spec, null, 2)}\n`,
      0o644,
    );
    converted = true;
  }
  if (state.binding.kind === 'legacy') {
    const legacy = state.binding.value as Record<string, unknown>;
    const kept: Record<string, unknown> = { version: 2 };
    for (const key of [
      'server',
      'team',
      'claim',
      'agent_key',
      'grant',
      'model',
      'capabilities',
      'session',
      'model_observed',
      'autojoin',
      'driver',
    ]) {
      if (legacy[key] !== undefined) kept[key] = legacy[key];
    }
    const next: Binding = BindingSchema.parse(kept);
    fs.mkdirp(join(worktreeRoot, BINDING_DIR));
    fs.writeFile(
      join(worktreeRoot, BINDING_DIR, BINDING_FILE),
      `${JSON.stringify(next, null, 2)}\n`,
      0o600,
    );
    converted = true;
  }

  const priorProfile =
    state.provisioning.kind === 'valid'
      ? state.provisioning.value.profile
      : (readProvisionManifest(worktreeRoot)?.role ?? '');
  const contributions =
    state.provisioning.kind === 'valid' ? state.provisioning.value.contributions : {};
  const provisioning: WorktreeProvisioning = {
    version: 2,
    profile: priorProfile,
    desired,
    contributions,
    provisionedAt: new Date(clock.now()).toISOString(),
  };
  saveProvisioning(worktreeRoot, provisioning, fs);
  if (state.provisioning.kind === 'legacy') converted = true;
  return converted;
}
