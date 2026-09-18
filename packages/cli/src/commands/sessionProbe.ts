/** The hook boundary must not turn a failed health probe into a failed harness startup. */
export type SessionStartProbe = (cwd: string | undefined) => Promise<void> | void;

/**
 * Run the shared SessionStart self-heal probe without creating a static doctor dependency.
 *
 * `doctor.ts` reaches the harness adapters and the self-heal implementation reaches doctor for
 * artifact inspection, so this edge stays lazy to keep hook-only command startup acyclic.
 */
export async function runSessionStartProbe(
  cwd: string | undefined,
  probe: SessionStartProbe = defaultSessionStartProbe,
): Promise<void> {
  try {
    await probe(cwd);
  } catch {
    // Harness hooks are fail-open: a dead daemon or unreadable workspace must not block startup.
  }
}

async function defaultSessionStartProbe(cwd: string | undefined): Promise<void> {
  const { runSessionProbe } = await import('../onboard/doctor.js');
  await runSessionProbe(cwd === undefined ? {} : { cwd });
}
