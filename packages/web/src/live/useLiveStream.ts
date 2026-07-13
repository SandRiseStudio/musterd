import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useEffect, useRef, useState } from 'react';
import {
  LiveClient,
  fetchHistory,
  fetchRoster,
  isStaleCredential,
  type ConnStatus,
  type LiveConfig,
} from './client';
import { firehoseSound } from './sound';

export interface LiveStreamHooks {
  /** Fired when the observer credential is stale/invalid (a 401 backfill or a WS `refused`) — the route
   * drops it and re-provisions instead of dead-ending. */
  onCredentialInvalid?: () => void;
  /** Fired once the backfill succeeds — lets the route re-arm its one-shot recovery guard. */
  onConnected?: () => void;
}

export interface LiveState {
  envelopes: Envelope[];
  roster: MemberSummary[];
  status: ConnStatus;
  error: string | null;
  /** Ids that arrived live over the socket (vs the initial backfill) — drives the typewriter. */
  liveIds: Set<string>;
  /** The daemon's build ref (ADR 130/135) — the reference member builds are compared against. */
  daemonBuild?: string | undefined;
}

/**
 * Backfill the team timeline then live-tail the firehose. Envelopes are deduped by `id` (delivery is
 * at-least-once, and a backfilled message can also arrive live) and kept in `ts,id` order. Pass `null`
 * to stay disconnected (before the operator has entered credentials).
 */
export function useLiveStream(cfg: LiveConfig | null, hooks: LiveStreamHooks = {}): LiveState {
  // Keep the latest callbacks in a ref so the connect effect doesn't re-run (and re-provision) when the
  // route re-renders with fresh closures — only cfg identity should drive reconnects.
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  // The daemon's build ref (ADR 130/135) — the reference the roster compares member builds against.
  const [daemonBuild, setDaemonBuild] = useState<string | undefined>(undefined);
  const [roster, setRoster] = useState<MemberSummary[]>([]);
  const [status, setStatus] = useState<ConnStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  // Ids we've already sounded — at-least-once delivery + reconnect replays must not double-chime.
  const chimedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!cfg) {
      setStatus('idle');
      return;
    }
    let alive = true;
    setEnvelopes([]);
    setLiveIds(new Set());
    setError(null);
    setStatus('connecting');

    // Dedupe by id against the *previous array* only — the updater must stay pure (no external
    // mutation), or React StrictMode's double-invoke commits the second (empty) result. Delivery is
    // at-least-once and a backfilled message can also arrive live, so dedup is load-bearing.
    const add = (incoming: Envelope[]) => {
      setEnvelopes((prev) => {
        const have = new Set(prev.map((e) => e.id));
        const fresh = incoming.filter((e) => !have.has(e.id));
        if (fresh.length === 0) return prev;
        return [...prev, ...fresh].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
      });
    };

    // The daemon's build (ADR 135): one same-origin fetch per mount, best-effort — an unreachable or
    // provenance-less daemon leaves it undefined and the stale chips simply never render.
    fetch('/health', { signal: AbortSignal.timeout(2500) })
      .then((r) => r.json())
      .then((h: { build?: string }) => {
        if (alive && h.build) setDaemonBuild(h.build);
      })
      .catch(() => {});

    // Backfill (roster + history) in parallel, then the socket live-tails on top.
    Promise.all([fetchRoster(cfg), fetchHistory(cfg, { limit: 200 })])
      .then(([r, h]) => {
        if (!alive) return;
        setRoster(r);
        add(h);
        hooksRef.current.onConnected?.(); // backfill worked → re-arm the route's recovery guard
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // A stale observer credential (wiped DB / expired TTL) → let the route re-provision instead of
        // dead-ending on an error banner the user can't clear.
        if (isStaleCredential(e)) {
          hooksRef.current.onCredentialInvalid?.();
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      });

    const client = new LiveClient(cfg, {
      onEnvelope: (e) => {
        if (!alive) return;
        // Mark live-arrived before adding (same render tick) so the row mounts knowing to type out.
        setLiveIds((prev) => (prev.has(e.id) ? prev : new Set(prev).add(e.id)));
        // Sound the arrival — but only for genuinely-now messages (a reconnect can replay recent
        // history over the socket), and once per id. The engine itself no-ops when muted.
        if (!chimedRef.current.has(e.id) && Date.now() - e.ts < 30_000) {
          chimedRef.current.add(e.id);
          firehoseSound.chime(e.act);
        }
        add([e]);
      },
      // Refetch the authoritative roster on any presence change — this carries presence/activity AND
      // places a node for a member who joined mid-session (a brand-new sender otherwise shows in the
      // stream but has no constellation node). Cheap at localhost scale; debounce if it ever isn't.
      onPresence: () => {
        if (!alive) return;
        fetchRoster(cfg)
          .then((r) => alive && setRoster(r))
          .catch(() => {});
      },
      onStatus: (s) => alive && setStatus(s),
      onError: (msg) => alive && setError(msg),
      onCredentialInvalid: () => alive && hooksRef.current.onCredentialInvalid?.(),
    });
    client.connect();

    return () => {
      alive = false;
      client.close();
    };
  }, [cfg?.team, cfg?.as, cfg?.token]);

  return { envelopes, roster, status, error, liveIds, daemonBuild };
}
