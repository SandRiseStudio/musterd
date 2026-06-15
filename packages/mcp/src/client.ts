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
  /** True while the member should hold presence — gates reconnect, cleared by leave()/close(). */
  private wantPresence = false;
  private joinedFlag = false;
  /** Resolves/rejects the in-flight join() on the first welcome / error frame. */
  private pendingJoin: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(private config: McpConfig) {}

  /** Whether this session currently occupies its member's seat (claimed presence, got welcome). */
  get joined(): boolean {
    return this.joinedFlag;
  }

  // reason: returns parsed JSON of varying shape; callers narrow at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  sendEnvelope(envelope: Envelope) {
    return this.request('POST', `/teams/${this.config.team}/messages`, { envelope });
  }

  roster(): Promise<{ members: MemberSummary[] }> {
    return this.request('GET', `/teams/${this.config.team}/members`);
  }

  async fetchInbox(
    unreadOnly = true,
  ): Promise<{ messages: Envelope[]; cursor: { last_read_ts: number } }> {
    const q = unreadOnly ? '?unread=1' : '';
    return this.request('GET', `/teams/${this.config.team}/inbox${q}`);
  }

  markRead(messageId: string) {
    return this.request('POST', `/teams/${this.config.team}/inbox/cursor`, {
      last_read_message_id: messageId,
    });
  }

  /**
   * Claim the member's seat: open the WS, `hello`, and resolve once the server sends `welcome`.
   * Rejects if the seat is already live in another session (`member_busy`) or the hello is refused.
   * Idempotent while already joined. Explicit activation — nothing claims presence before this (M3).
   */
  join(): Promise<void> {
    if (this.joinedFlag) return Promise.resolve();
    this.wantPresence = true;
    return new Promise<void>((resolve, reject) => {
      this.pendingJoin = { resolve, reject };
      this.openSocket();
    });
  }

  /** Release the seat (back to dormant). The server keeps a 45s reclaim grace; tools stay registered. */
  leave(): void {
    this.wantPresence = false;
    this.joinedFlag = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.ws?.close();
    this.ws = null;
  }

  /** Open the background WS and send hello; (re)used by join() and reconnect. */
  private openSocket(): void {
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
        this.joinedFlag = true;
        ws.send(JSON.stringify({ type: 'subscribe', scope: 'team' }));
        this.heartbeat = setInterval(() => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
        }, 15_000);
        this.heartbeat.unref?.();
        this.pendingJoin?.resolve();
        this.pendingJoin = null;
      } else if (frame.type === 'error') {
        // A refused hello (e.g. member_busy) is terminal — don't thrash reconnecting.
        this.wantPresence = false;
        this.pendingJoin?.reject(
          new Error(frame.code === 'member_busy' ? `member_busy: ${frame.message}` : frame.message),
        );
        this.pendingJoin = null;
        ws.close();
      } else if (frame.type === 'deliver') {
        this.push(frame.envelope);
      }
    });
    ws.on('close', () => {
      this.joinedFlag = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.pendingJoin) {
        this.pendingJoin.reject(new Error('connection closed before join completed'));
        this.pendingJoin = null;
        this.wantPresence = false;
        return;
      }
      this.scheduleReconnect();
    });
    ws.on('error', () => {
      /* the close handler rejects/reschedules */
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.wantPresence) return;
    const delay = Math.min(this.backoff, 30_000);
    this.backoff = Math.min(this.backoff * 2, 30_000);
    const t = setTimeout(() => this.openSocket(), delay);
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
    this.wantPresence = false;
    this.joinedFlag = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
