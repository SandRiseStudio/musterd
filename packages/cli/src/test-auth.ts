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
