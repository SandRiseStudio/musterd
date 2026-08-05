import { basename, relative } from 'node:path';
import {
  PROVENANCES,
  resolveAttestedModel,
  resolveAttestedWakeLease,
  type Provenance,
} from '@musterd/protocol';
import { gitOutput, gitToplevel } from '@musterd/protocol/project';

/**
 * The "where"-on-attach seed (human-agent-dynamics §2; ADR 014). A gracefully-degrading workspace
 * label, captured once at join and read out of the roster — never asked of the agent per status.
 *
 * Degradation ladder (locked decisions):
 *   1. declared override — `MUSTERD_WORKSPACE` wins verbatim (one-time "what are you working on?").
 *   2. floor — the cwd folder name, which always exists.
 *   3. qualifier — the *most specific* available leads: git branch when informative, else the cwd
 *      subpath within the repo, else nothing. A git-less project degrades cleanly to the bare folder.
 *
 * Rendered dim, as location context — it is approximately right by design, not an authoritative scope.
 */
export function resolveWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const declared = env['MUSTERD_WORKSPACE']?.trim();
  if (declared) return declared.slice(0, 120);

  const folder = basename(cwd) || cwd;
  const git = gitContext(cwd);
  const qualifier = git?.branch || git?.subpath || '';
  const label = qualifier ? `${folder}@${qualifier}` : folder;
  return label.slice(0, 120);
}

/**
 * The wake correlation token (ADR 241) for this session, from `MUSTERD_WAKE_LEASE` via the shared
 * protocol resolver — so the adapter and the CLI's ambient touches attest the same value the same
 * way, exactly as they already do for model and provenance.
 *
 * Note the asymmetry with {@link resolveProvenance} directly below, which is deliberate: provenance
 * DEFAULTS (`session` is the honest description of an unlabelled session), and this one never does.
 * A default here would turn "I don't know what spawned me" into "this lease spawned me", which is
 * the false assertion ADR 236 exists to forbid and the exact bug this token was added to fix.
 */
export function resolveWakeLease(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveAttestedWakeLease(env);
}

/** Read provenance from `MUSTERD_PROVENANCE`, defaulting to `session` (the common human-driven case). */
export function resolveProvenance(env: NodeJS.ProcessEnv = process.env): Provenance {
  const raw = env['MUSTERD_PROVENANCE'];
  return (PROVENANCES as readonly string[]).includes(raw ?? '') ? (raw as Provenance) : 'session';
}

/**
 * Driver co-presence (ADR 021): the human steering this session, read from `MUSTERD_DRIVER`
 * (capped at 80 chars) — the manual override tier; provisioning writes `binding.driver` instead
 * (ADR 165 inc 2) and `loadMcpConfig` falls back to it. The roster renders `driven by nick`
 * instead of showing the driving human offline. Undefined when unset — the adapter authenticates
 * only as the agent and never invents a driver it wasn't told about.
 */
export function resolveDriver(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env['MUSTERD_DRIVER']?.trim();
  return raw ? raw.slice(0, 80) : undefined;
}

/**
 * Model attestation (ADR 101): the model id this harness session runs, resolved from the env
 * (`MUSTERD_MODEL`, else `ANTHROPIC_MODEL`) via the shared protocol helper. Attested, never
 * verified — only the harness knows; the value attaches to the *occupancy* (the durable seat stays
 * model-agnostic, ADR 087). Undefined when nothing declares it — the server renders that as
 * `unknown` and never blocks (a thin harness is legal).
 */
export function resolveModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveAttestedModel(env);
}

interface GitContext {
  /** Current branch, or '' when detached/unavailable (a detached HEAD is not informative). */
  branch: string;
  /** Path from the repo root down to cwd, or '' at the root. */
  subpath: string;
}

function gitContext(cwd: string): GitContext | null {
  const top = gitToplevel(cwd);
  if (!top) return null;
  const branchRaw = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : '';
  const subpath = relative(top, cwd);
  return { branch, subpath: subpath === '' || subpath.startsWith('..') ? '' : subpath };
}
