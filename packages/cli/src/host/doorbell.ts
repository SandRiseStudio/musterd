import type { DoorbellRecord, DoorbellRingsResponse } from '@musterd/protocol';
import { HttpClient } from '../client.js';
import { type NotifyItem, osNotify } from '../notify/os.js';
import { defaultReadAgentKey, pollGroups } from './loop.js';
import { type HostRegistryEntry, loadHostRegistry } from './registry.js';

/**
 * The doorbell's `os` sink, host half (ADR 443 §3). The daemon may be a synced peer on another
 * machine; the host is the one process already running on the human's own machine. So each tick
 * the host claims the rings queued for its label, raises one OS banner per ring, and reports it.
 *
 * The banner is built from the record's structured fields only — the record carries no body, and
 * `buildNotifyCommand` passes the text as argv, never as script source. A quiet tick logs nothing
 * (ADR 131's carve-out); a failure logs one line and never stops the wake loop beside it.
 */

export interface DoorbellClient {
  rings(team: string, host: string): Promise<DoorbellRingsResponse>;
  surfaced(team: string, ringId: string, host: string, ok: boolean): Promise<unknown>;
}

export interface DoorbellPollDeps {
  log: (line: string) => void;
  /** Override every entry's enrolled host label (the `--host` flag). */
  hostLabel?: string;
  // ── injectables (tests) ──
  loadRegistry?: () => { entries: HostRegistryEntry[] };
  readAgentKey?: (workspace: string) => string | undefined;
  doorbellClientFor?: (server: string, agentKey: string) => DoorbellClient;
  notify?: (n: NotifyItem) => void;
}

const defaultDoorbellClientFor = (server: string, agentKey: string): DoorbellClient => {
  const http = new HttpClient({ server, key: agentKey }).presenceNeutral();
  return {
    rings: (team, host) => http.doorbellRings(team, host),
    surfaced: (team, ringId, host, ok) => http.doorbellSurfaced(team, ringId, host, ok),
  };
};

/** The species verb at the human — the phrasing the Slack sink and `musterd notify` share. */
function askPhrase(record: DoorbellRecord): string {
  if (record.species === 'escalate') return `${record.from} escalated to you`;
  if (record.species === 'approve') return `${record.from} needs your approval`;
  return `${record.from} asks what you think`;
}

/** The banner for one ring: record fields only, never a body. */
export function doorbellBanner(ringId: string, record: DoorbellRecord): NotifyItem {
  const title = `musterd [${record.team}]`;
  if (record.act === 'ask') {
    const tier = record.tier ? ` (${record.tier})` : '';
    return { id: ringId, title, body: `${askPhrase(record)}${tier}` };
  }
  if (record.act === 'handoff')
    return { id: ringId, title, body: `${record.from} handed you work` };
  if (record.act === 'request_help')
    return { id: ringId, title, body: `${record.from} needs your help` };
  return { id: ringId, title, body: `${record.from} sent you a ${record.act}` };
}

/** One tick: per (daemon, team, host label), claim → banner → report. Returns banners raised. */
export async function pollDoorbellOnce(deps: DoorbellPollDeps): Promise<number> {
  const registry = (deps.loadRegistry ?? loadHostRegistry)();
  const readAgentKey = deps.readAgentKey ?? defaultReadAgentKey;
  const clientFor = deps.doorbellClientFor ?? defaultDoorbellClientFor;
  const notify = deps.notify ?? osNotify;
  let raised = 0;

  for (const group of pollGroups(registry.entries, deps.hostLabel).values()) {
    const key = group.entries.map((e) => readAgentKey(e.workspace)).find((k) => k !== undefined);
    // The wake poll beside this one already logs an unreadable key; saying it twice is noise.
    if (key === undefined) continue;
    const client = clientFor(group.server, key);
    let response: DoorbellRingsResponse;
    try {
      response = await client.rings(group.team, group.host);
    } catch (err) {
      deps.log(`! doorbell poll failed for ${group.team}: ${(err as Error).message}`);
      continue;
    }
    for (const ring of response.rings) {
      let ok = true;
      try {
        notify(doorbellBanner(ring.id, ring.record));
        raised++;
      } catch {
        ok = false;
      }
      await client.surfaced(group.team, ring.id, group.host, ok).catch((err: Error) => {
        deps.log(`! doorbell report failed for ${group.team}: ${err.message}`);
      });
    }
  }
  return raised;
}
