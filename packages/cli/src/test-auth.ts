import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveBinding } from './config.js';

export interface AgentHttpAuth {
  key: string;
  seat: string;
  sessionLease: string;
}

/** Claim an agent seat for CLI integration fixtures and return its routine HTTP authority. */
export async function claimAgentHttp(
  base: string,
  team: string,
  agentKey: string,
  adminCredential: string,
  seat: string,
): Promise<AgentHttpAuth> {
  const grantResponse = await fetch(`${base}/teams/${team}/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminCredential}` },
    body: JSON.stringify({ scope: 'seat', target: seat, lifetime: 'standing' }),
  });
  if (!grantResponse.ok)
    throw new Error(`failed to mint ${seat} test grant: ${grantResponse.status}`);
  const { token } = (await grantResponse.json()) as { token: string };

  const claimResponse = await fetch(`${base}/teams/${team}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key: agentKey,
      target: { seat },
      grant: token,
      surface: 'cli',
    }),
  });
  if (!claimResponse.ok)
    throw new Error(`failed to claim ${seat} test authority: ${claimResponse.status}`);
  const claim = (await claimResponse.json()) as {
    seat_credential: string;
    session_lease: string;
  };
  return { key: claim.seat_credential, seat, sessionLease: claim.session_lease };
}

/**
 * Test-only (ADR 442): a fresh folder bound to `(team, name)` from this machine's vault, and its path.
 *
 * `--as` used to let a fixture act as any vault identity from one folder. That path is gone for
 * everyone, so a fixture that needs a second actor does what a real one does: stands in that
 * member's own Workspace. The caller points `process.cwd()` at the returned path for the call.
 */
export function bindTempWorkspace(team: string, name: string): string {
  const config = loadConfig();
  const held =
    config.knownIdentities.find((i) => i.team === team && i.name === name) ??
    (config.identities[team]?.name === name ? config.identities[team] : undefined);
  if (!held) throw new Error(`no vault identity for ${name} on ${team} — remember it first`);
  const dir = mkdtempSync(join(tmpdir(), `musterd-as-${name}-`));
  const isSeatCredential = held.key.startsWith('msac_');
  saveBinding(dir, {
    version: 2,
    server: config.server,
    team,
    claim: { mode: 'seat', name },
    ...(isSeatCredential
      ? {
          seat_credential: held.key,
          ...(held.sessionLease !== undefined ? { session_lease: held.sessionLease } : {}),
        }
      : { agent_key: held.key }),
  });
  return dir;
}
