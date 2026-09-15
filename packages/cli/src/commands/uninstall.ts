import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { BINDING_DIR, BINDING_FILE } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { loadBinding, loadConfig, saveConfig } from '../config.js';
import { removeGuidance } from '../onboard/guidance.js';
import type { Harness } from '../onboard/harness.js';
import { HARNESSES } from '../onboard/harnesses/index.js';
import {
  loadProvisioning,
  PROVISION_MANIFEST_FILE,
  readProvisionManifest,
  saveProvisioning,
} from '../onboard/manifest.js';
import { classifyPrimerTarget, removePrimer } from '../onboard/primer.js';
import { defaultHarnessContext, type HarnessContext } from '../onboard/reconcile/context.js';
import { reconcileHarnesses } from '../onboard/reconcile/engine.js';
import type { HarnessAdapter } from '../onboard/reconcile/fragments.js';
import { theme } from '../render/theme.js';
import { hint, success, sym } from '../render/ui.js';

/**
 * Per-folder uninstall (ADR 027 reversibility — the gap `reset` left open). Removes *exactly* what
 * `musterd init` wrote into this folder's harness, restoring the prior state:
 *  - the role-provisioned MCP servers + permission entries (from the manifest, ADR 030),
 *  - the musterd MCP server itself,
 *  - the managed AGENTS.md primer block (the user's own prose is kept),
 *  - the local `.musterd/` state (binding + manifest) and this folder's registry entry.
 *
 * Purely local + additive's inverse: it never touches the server roster — the member stays on the
 * team (offline); removing it server-side is the v0.3 seat model. Never imports @musterd/server.
 */
export interface UninstallDeps {
  ctx?: HarnessContext;
  registry?: HarnessAdapter[];
}

export async function uninstallCommand(parsed: Parsed, deps?: UninstallDeps): Promise<number> {
  const force = Boolean(parsed.flags['force'] || parsed.flags['yes']);
  const dir = process.cwd();

  // ── The v2 path (ADR 282): reconcile to an EMPTY desired set, then clean up only what is
  // provably released. Any blocked fragment retains identity, manifest, ledger, and journal
  // evidence for retry — an uninstall must never orphan owned fragments by deleting the records.
  const ctx = deps?.ctx ?? defaultHarnessContext(dir);
  const v2 = loadProvisioning(ctx.worktreeRoot, ctx.fs);
  if (v2.kind === 'valid') {
    if (!force) {
      if (!process.stdin.isTTY) {
        process.stderr.write(
          `${theme.err(sym.err)} refusing to uninstall without confirmation — re-run with --force\n`,
        );
        return 2;
      }
      process.stdout.write(
        `${theme.warn(sym.warn)} ${theme.accent('musterd uninstall')} will deselect every harness in ${theme.meta(dir)}, ` +
          `release this worktree's owned fragments (${v2.value.desired.join(', ') || 'none selected'}), ` +
          `strip the primer/guidance, and remove local .musterd state.\n` +
          `  ${theme.meta('the member stays on the team roster (offline) — removing it is server-side, v0.3')}\n`,
      );
      if (!(await confirm('proceed?'))) {
        process.stdout.write('aborted — nothing was changed\n');
        return 0;
      }
    }
    // Save desire FIRST (ADR 282): a stop right after leaves honest intent for the next wire.
    saveProvisioning(ctx.worktreeRoot, { ...v2.value, desired: [] }, ctx.fs);
    const report = await reconcileHarnesses(ctx, [], {
      legacyRepair: false,
      ...(deps?.registry ? { registry: deps.registry } : {}),
    });
    // Role MCP servers are not fragment-modeled yet: init records them under the `role-tools`
    // pseudo-key (`role-server <harnessId> <name>`), and this is where they are unwound — via the
    // legacy per-harness unprovision, exactly by name.
    const roleServers = v2.value.contributions['role-tools'] ?? [];
    const byHarness = new Map<string, string[]>();
    for (const entry of roleServers) {
      const m = /^role-server (\S+) (.+)$/.exec(entry);
      if (m) byHarness.set(m[1]!, [...(byHarness.get(m[1]!) ?? []), m[2]!]);
    }
    for (const [harnessId, servers] of byHarness) {
      const legacyHarness = HARNESSES.find((h) => h.id === harnessId);
      try {
        await legacyHarness?.unprovision?.(
          { servers, permissions: { allow: [], ask: [], deny: [] } },
          'local',
        );
      } catch (err) {
        process.stderr.write(
          `${theme.warn(sym.warn)} couldn't unwind ${harnessId} role tools: ${(err as Error).message}\n`,
        );
      }
    }
    const after = loadProvisioning(ctx.worktreeRoot, ctx.fs);
    const released =
      report.ok &&
      after.kind === 'valid' &&
      Object.keys(after.value.contributions).filter((k) => k !== 'role-tools').length === 0;
    if (!released) {
      for (const r of report.results) {
        if (r.result !== 'applied' && r.result !== 'unchanged') {
          process.stderr.write(
            `${theme.warn(sym.warn)} ${r.harness}: ${r.result}${r.detail ? ` — ${r.detail}` : ''}\n`,
          );
        }
      }
      process.stderr.write(
        `${theme.err(sym.err)} not everything could be released — identity, manifest, ledger, and ` +
          'journal evidence are retained. `musterd harness status` for the detail; re-run to retry.\n',
      );
      return 1;
    }
    const primer = removePrimer(dir);
    const guidance = removeGuidance(dir, HARNESSES);
    rmSync(join(dir, BINDING_DIR, PROVISION_MANIFEST_FILE), { force: true });
    rmSync(join(dir, BINDING_DIR, BINDING_FILE), { force: true });
    rmSync(join(dir, BINDING_DIR, 'workspace.json'), { force: true });
    try {
      const config = loadConfig();
      if (config.bindings[resolve(dir)]) {
        delete config.bindings[resolve(dir)];
        saveConfig(config);
      }
    } catch {
      // registry is advisory — never let it fail the uninstall
    }
    process.stdout.write(
      `${theme.ok(sym.ok)} uninstalled musterd from ${theme.meta(dir)} — every owned fragment released` +
        (primer.action === 'removed' ? `; stripped the AGENTS.md primer` : '') +
        (guidance.removed.length ? `; removed ${guidance.removed.length} guidance file(s)` : '') +
        `.\n`,
    );
    process.stdout.write(hint('re-add any time with musterd init') + '\n');
    return 0;
  }

  // ── The pre-ADR-281 path: unwind by the v1 manifest, exactly as before. Uninstalling legacy
  // state is removal, not conversion, so it stays allowed without `harness configure`. The binding
  // is CLASSIFIED, never thrown on: a legacy binding is exactly what this path expects to remove.
  const bindingLoad = loadBinding(dir);
  const binding = bindingLoad.kind === 'valid' ? bindingLoad.value : null;
  const manifest = readProvisionManifest(dir);
  const bindingPath = join(dir, BINDING_DIR, BINDING_FILE);
  const manifestPath = join(dir, BINDING_DIR, PROVISION_MANIFEST_FILE);

  const localState = existsSync(bindingPath) || existsSync(manifestPath);
  const hasPrimer = classifyPrimerTarget(dir) === 'managed';

  // Identify the harness whose config we'll unwind: prefer the manifest's record, then the captured
  // session's harness (identity declares no surface since ADR 281). Only fall back to the (slow)
  // detect probe when there's evidence something is installed — a clean folder shouldn't pay for
  // shelling out to every harness CLI.
  let harness = harnessByIdOrSurface(manifest?.harness, binding?.session?.harness);
  if (!harness && (localState || hasPrimer)) harness = await firstConfigured();

  if (!harness && !localState && !hasPrimer) {
    process.stdout.write(success('nothing musterd installed in this folder') + '\n');
    return 0;
  }

  const servers = [...(manifest?.mcpServers ?? []), 'musterd'];
  const permissions = manifest?.permissions ?? { allow: [], ask: [], deny: [] };

  // Confirm — interactive on a TTY; otherwise require --force so scripts can't unwind silently.
  if (!force) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        `${theme.err(sym.err)} refusing to uninstall without confirmation — re-run with --force\n`,
      );
      return 2;
    }
    process.stdout.write(
      `${theme.warn(sym.warn)} ${theme.accent('musterd uninstall')} will remove from ${theme.meta(dir)}:\n` +
        (harness
          ? `  ${theme.meta(sym.bullet)} ${harness.label} MCP server${servers.length > 1 ? 's' : ''}: ${servers.join(', ')}\n`
          : '') +
        (countPerms(permissions)
          ? `  ${theme.meta(sym.bullet)} ${countPerms(permissions)} provisioned permission(s)\n`
          : '') +
        `  ${theme.meta(sym.bullet)} the AGENTS.md musterd primer block (your own content is kept)\n` +
        `  ${theme.meta(sym.bullet)} the musterd skill + slash commands this folder carries\n` +
        `  ${theme.meta(sym.bullet)} local .musterd state (binding + manifest)\n` +
        `  ${theme.meta('the member stays on the team roster (offline) — removing it is server-side, v0.3')}\n`,
    );
    if (!(await confirm('proceed?'))) {
      process.stdout.write('aborted — nothing was changed\n');
      return 0;
    }
  }

  // 1) Unwind the harness footprint (servers + permissions).
  if (harness?.unprovision) {
    try {
      await harness.unprovision({ servers, permissions }, 'local');
    } catch (err) {
      process.stderr.write(
        `${theme.warn(sym.warn)} couldn't fully unwind ${harness.label}: ${(err as Error).message}\n`,
      );
    }
  } else if (harness) {
    process.stderr.write(
      `${theme.warn(sym.warn)} ${harness.label} has no uninstall renderer yet — remove its musterd servers by hand.\n`,
    );
  }

  // 2) Strip the managed primer block, keeping the user's prose.
  const primer = removePrimer(dir);

  // 2b) Remove the skill + slash commands musterd wrote (ADR 085). Stamp-gated inside removeGuidance,
  // so a user-authored file at the same path is never deleted.
  const guidance = removeGuidance(dir, HARNESSES);

  // 3) Remove local state + this folder's registry entry.
  rmSync(manifestPath, { force: true });
  rmSync(bindingPath, { force: true });
  try {
    const config = loadConfig();
    if (config.bindings[resolve(dir)]) {
      delete config.bindings[resolve(dir)];
      saveConfig(config);
    }
  } catch {
    // registry is advisory — never let it fail the uninstall
  }

  process.stdout.write(
    `${theme.ok(sym.ok)} uninstalled musterd from ${theme.meta(dir)}` +
      (harness ? ` — removed ${servers.length} server(s) from ${harness.label}` : '') +
      (primer.action === 'removed' ? `; stripped the AGENTS.md primer` : '') +
      (guidance.removed.length ? `; removed ${guidance.removed.length} guidance file(s)` : '') +
      `.\n`,
  );
  process.stdout.write(hint('re-add any time with musterd init') + '\n');
  return 0;
}

/** Pick the harness adapter by the manifest's recorded id, else the binding's surface. */
function harnessByIdOrSurface(
  manifestHarness: string | undefined,
  surface: string | undefined,
): Harness | undefined {
  if (manifestHarness) {
    const byId = HARNESSES.find((h) => h.id === manifestHarness);
    if (byId) return byId;
  }
  if (surface) return HARNESSES.find((h) => h.surface === surface);
  return undefined;
}

/** Slow fallback: the first harness that detects itself as musterd-configured here. */
async function firstConfigured(): Promise<Harness | undefined> {
  for (const h of HARNESSES) {
    if ((await h.detect()).configured) return h;
  }
  return undefined;
}

function countPerms(p: { allow: string[]; ask: string[]; deny: string[] }): number {
  return p.allow.length + p.ask.length + p.deny.length;
}

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      res(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
