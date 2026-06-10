import {
  ErrorBodySchema,
  PROTOCOL_VERSION,
  type Envelope,
  type MemberSummary,
  type WSServerFrame,
} from '@musterd/protocol';
import { WebSocket } from 'ws';
import type { McpConfig } from './config.js';

function wsBase(server: string): string {
  return server.replace(/^http/, 'ws');
}

/**
 * HTTP client + background WS that holds presence and buffers inbound deliveries.
 * The buffer is a convenience; the server log + cursor are authoritative, so a
 * dropped socket never loses messages (they resurface via the inbox cursor).
 */
export class MusterdClient {
  private buffer: Envelope[] = [];
  private seen = new Set<string>();
  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private closed = false;

  constructor(private config: McpConfig) {}

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(this.config.server + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      throw new Error(parsed.success ? parsed.data.error.message : `server error ${res.status}`);
    }
    return json;
  }

  async health(): Promise<void> {
    await this.request('GET', '/health');
  }

  /** Register a presence row (online) over HTTP — the immediate, stateless attach. */
  async registerPresence(): Promise<void> {
    await this.request('POST', `/teams/${this.config.team}/presence`, { surface: this.config.surface, status: 'online' });
  }

  sendEnvelope(envelope: Envelope) {
    return this.request('POST', `/teams/${this.config.team}/messages`, { envelope });
  }

  roster(): Promise<{ members: MemberSummary[] }> {
    return this.request('GET', `/teams/${this.config.team}/members`);
  }

  async fetchInbox(unreadOnly = true): Promise<{ messages: Envelope[]; cursor: { last_read_ts: number } }> {
    const q = unreadOnly ? '?unread=1' : '';
    return this.request('GET', `/teams/${this.config.team}/inbox${q}`);
  }

  markRead(messageId: string) {
    return this.request('POST', `/teams/${this.config.team}/inbox/cursor`, { last_read_message_id: messageId });
  }

  /** Open the background WS so the member is present and live deliveries are buffered. */
  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(wsBase(this.config.server) + '/ws');
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      ws.send(
        JSON.stringify({
          type: 'hello',
          v: PROTOCOL_VERSION,
          team: this.config.team,
          as: this.config.member,
          token: this.config.token,
          surface: this.config.surface,
        }),
      );
    });
    ws.on('message', (data) => {
      let frame: WSServerFrame;
      try {
        frame = JSON.parse(data.toString()) as WSServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'welcome') {
        ws.send(JSON.stringify({ type: 'subscribe', scope: 'team' }));
        this.heartbeat = setInterval(() => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
        }, 15_000);
        this.heartbeat.unref?.();
      } else if (frame.type === 'deliver') {
        this.push(frame.envelope);
      }
    });
    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', () => {
      /* close handler schedules reconnect */
    });
  }

  private scheduleReconnect(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.closed) return;
    const delay = Math.min(this.backoff, 30_000);
    this.backoff = Math.min(this.backoff * 2, 30_000);
    const t = setTimeout(() => this.connect(), delay);
    t.unref?.();
  }

  private push(env: Envelope): void {
    if (this.seen.has(env.id)) return;
    this.seen.add(env.id);
    this.buffer.push(env);
  }

  /** Drain buffered live deliveries (dedup by id is already applied). */
  drainBuffer(): Envelope[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  markSeen(id: string): void {
    this.seen.add(id);
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
