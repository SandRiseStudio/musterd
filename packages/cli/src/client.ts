import {
  ErrorBodySchema,
  PROTOCOL_VERSION,
  type Envelope,
  type MemberSummary,
  type WSServerFrame,
} from '@musterd/protocol';
import { WebSocket } from 'ws';
import { CliError, exitForCode, isConnRefused } from './errors.js';

export interface HttpClientOpts {
  server: string;
  token?: string;
}

export class HttpClient {
  constructor(private opts: HttpClientOpts) {}

  // reason: returns parsed JSON of varying shape; callers narrow at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.opts.server + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (isConnRefused(err)) {
        throw new CliError(
          `can't reach team server at ${this.opts.server} — is the daemon running? (musterd serve)`,
          7,
        );
      }
      throw err;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      if (parsed.success) {
        throw new CliError(parsed.data.error.message, exitForCode(parsed.data.error.code));
      }
      throw new CliError(`server error (${res.status})`, 1);
    }
    return json;
  }

  createTeam(slug: string, creator: { name: string; role?: string }, display?: string) {
    return this.request('POST', '/teams', {
      slug,
      display,
      creator: { name: creator.name, kind: 'human', role: creator.role },
    });
  }
  addMember(slug: string, body: Record<string, unknown>) {
    return this.request('POST', `/teams/${slug}/members`, body);
  }
  roster(slug: string): Promise<{ members: MemberSummary[] }> {
    return this.request('GET', `/teams/${slug}/members`);
  }
  send(slug: string, envelope: Envelope) {
    return this.request('POST', `/teams/${slug}/messages`, { envelope });
  }
  inbox(
    slug: string,
    opts: { unread?: boolean; limit?: number } = {},
  ): Promise<{ messages: Envelope[]; cursor: { last_read_ts: number } }> {
    const q = new URLSearchParams();
    if (opts.unread) q.set('unread', '1');
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request('GET', `/teams/${slug}/inbox${qs ? `?${qs}` : ''}`);
  }
  markRead(slug: string, lastReadMessageId: string) {
    return this.request('POST', `/teams/${slug}/inbox/cursor`, {
      last_read_message_id: lastReadMessageId,
    });
  }
  presence(slug: string, surface: string, status?: string) {
    return this.request('POST', `/teams/${slug}/presence`, { surface, status });
  }
}

export interface WatchOpts {
  wsUrl: string;
  team: string;
  as: string;
  token: string;
  surface: string;
  /** Attach-time context (ADR 014): why this watch session exists + its workspace label. */
  provenance?: string;
  workspace?: string;
  onDeliver: (env: Envelope) => void;
  onPresence?: (member: string, status: string, surface?: string) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

/** Open a live WS presence session and stream deliveries (used by `inbox --watch`). */
export function watch(opts: WatchOpts): { close: () => void } {
  const ws = new WebSocket(opts.wsUrl);
  let heartbeat: NodeJS.Timeout | undefined;

  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        v: PROTOCOL_VERSION,
        team: opts.team,
        as: opts.as,
        token: opts.token,
        surface: opts.surface,
        ...(opts.provenance ? { provenance: opts.provenance } : {}),
        ...(opts.workspace ? { workspace: opts.workspace } : {}),
      }),
    );
  });
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as WSServerFrame;
    switch (frame.type) {
      case 'welcome':
        ws.send(JSON.stringify({ type: 'subscribe', scope: 'team' }));
        heartbeat = setInterval(() => ws.send(JSON.stringify({ type: 'heartbeat' })), 15_000);
        heartbeat.unref?.();
        opts.onReady?.();
        break;
      case 'deliver':
        opts.onDeliver(frame.envelope);
        break;
      case 'presence':
        opts.onPresence?.(frame.member, frame.status, frame.surface);
        break;
      case 'error':
        opts.onError?.(frame.message);
        break;
    }
  });
  ws.on('error', (err) => opts.onError?.(err.message));

  return {
    close: () => {
      if (heartbeat) clearInterval(heartbeat);
      ws.close();
    },
  };
}
