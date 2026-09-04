import { request } from 'node:http';
import { TailscaleServeStatusSchema, TailscaleStatusSchema } from '@musterd/protocol';

export interface TailnetSelf {
  dnsName: string;
  ip4: string | null;
  running: boolean;
}

export type UpgradeVerdict = 'allowed' | 'rejected' | 'unreachable';

export function parseTailscaleSelf(json: string): TailnetSelf | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = TailscaleStatusSchema.safeParse(parsed);
  if (!result.success) return null;
  const { Self } = result.data;
  if (!Self.DNSName) return null;
  const ip4 = Self.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
  return {
    dnsName: Self.DNSName.replace(/\.$/, ''),
    ip4,
    running: Self.Online === true || result.data.BackendState === 'Running',
  };
}

export function serveForwardsPort(json: string, port: number): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  const result = TailscaleServeStatusSchema.safeParse(parsed);
  return result.success && Boolean(result.data.TCP?.[String(port)]?.TCPForward);
}

export function probeUpgradeHost(
  origin: { hostname: string; port: number },
  host: string,
  timeoutMs = 3000,
): Promise<UpgradeVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (verdict: UpgradeVerdict) => {
      if (!settled) {
        settled = true;
        resolve(verdict);
      }
    };
    const req = request({
      host: origin.hostname,
      port: origin.port,
      path: '/ws',
      headers: {
        Host: host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
      timeout: timeoutMs,
    });
    req.on('upgrade', (_response, socket) => {
      socket.destroy();
      done('allowed');
    });
    req.on('response', (response) => {
      response.resume();
      done(response.statusCode === 403 ? 'rejected' : 'allowed');
    });
    req.on('timeout', () => {
      req.destroy();
      done('unreachable');
    });
    req.on('error', () => done('unreachable'));
    req.end();
  });
}
