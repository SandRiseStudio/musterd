import { resolveRead } from './commands/helpers.js';

/**
 * The CLI half of the warn-only infra-touch gate (ADR 227 inc 2). Before an infra verb runs
 * (`service install|restart|refresh`, `reset`), ask the daemon whether the acting seat holds the
 * `platform` role; a non-holder agent seat gets back a one-line warning naming the current holders,
 * which the caller prints and then PROCEEDS. The daemon owns the decision and writes the
 * `infra.touch.warned` audit row — this side supplies no audit content.
 *
 * The load-bearing property is the silence contract: this check may only ever ADD a line. Every
 * failure mode — no workspace-explicit identity (an unbound folder / plain human shell), daemon
 * unreachable, an old daemon without the route, a malformed body — collapses to `null`. A health
 * check must never be a prerequisite for the command that fixes health: `service install` on a dead
 * daemon has to sail through its own guard.
 */

export interface GateIdentity {
  server: string;
  team: string;
  name: string;
  key: string;
  surface: string;
}

/** How long the gate will wait on the daemon before shrugging: a warning is not worth a stall. */
const GATE_TIMEOUT_MS = 1_500;

/**
 * The default identity resolution: the workspace-explicit identity (binding/env, ADR 036/143) —
 * exactly the identity the verb itself would act under. Ambient config-only identities don't count
 * (a bare `cd` into an unrelated folder must not warn as a teammate), and any resolution failure is
 * silence. Bails under vitest: the machine-state isolation (ADR 190) covers `~/.musterd` but not a
 * repo-local `binding.json` on the walk-up path, and a unit test must never reach a real daemon —
 * tests inject `identity` instead.
 */
function ambientIdentity(): GateIdentity | null {
  if (process.env['VITEST']) return null;
  try {
    // A gate path: takes the default (no reclaim). #1138's own ResolveReadOptions doc named
    // infra-gate as a must-not-reclaim caller while the code still reclaimed by default.
    const r = resolveRead({});
    if (!r.explicit || !r.identity) return null;
    return {
      server: r.config.server,
      team: r.team,
      name: r.identity.name,
      key: r.identity.key,
      surface: r.identity.surface,
    };
  } catch {
    return null;
  }
}

export async function infraTouchWarning(
  verb: string,
  deps: {
    identity?: () => GateIdentity | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<string | null> {
  const id = (deps.identity ?? ambientIdentity)();
  if (!id) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(
      `${id.server}/teams/${encodeURIComponent(id.team)}/infra-gate?verb=${encodeURIComponent(verb)}`,
      {
        headers: {
          authorization: `Bearer ${id.key}`,
          'x-musterd-seat': id.name,
        },
        signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { warn?: { text?: string } | null };
    return body.warn?.text ?? null;
  } catch {
    return null;
  }
}
