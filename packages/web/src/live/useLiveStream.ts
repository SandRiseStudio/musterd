import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useEffect, useRef, useState } from 'react';
import {
  LiveClient,
  fetchHistory,
  fetchRoster,
  type ConnStatus,
  type LiveConfig,
} from './client';

export interface LiveState {
  envelopes: Envelope[];
  roster: MemberSummary[];
  status: ConnStatus;
  error: string | null;
}

/**
 * Backfill the team timeline then live-tail the firehose. Envelopes are deduped by `id` (delivery is
 * at-least-once, and a backfilled message can also arrive live) and kept in `ts,id` order. Pass `null`
 * to stay disconnected (before the operator has entered credentials).
 */
export function useLiveStream(cfg: LiveConfig | null): LiveState {
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [roster, setRoster] = useState<MemberSummary[]>([]);
  const [status, setStatus] = useState<ConnStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!cfg) {
      setStatus('idle');
      return;
    }
    let alive = true;
    seen.current = new Set();
    setEnvelopes([]);
    setError(null);
    setStatus('connecting');

    const add = (incoming: Envelope[]) => {
      setEnvelopes((prev) => {
        const next = prev.slice();
        let changed = false;
        for (const e of incoming) {
          if (seen.current.has(e.id)) continue;
          seen.current.add(e.id);
          next.push(e);
          changed = true;
        }
        if (!changed) return prev;
        next.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
        return next;
      });
    };

    // Backfill (roster + history) in parallel, then the socket live-tails on top.
    Promise.all([fetchRoster(cfg), fetchHistory(cfg, { limit: 200 })])
      .then(([r, h]) => {
        if (!alive) return;
        setRoster(r);
        add(h);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });

    const client = new LiveClient(cfg, {
      onEnvelope: (e) => alive && add([e]),
      onPresence: (member, st) => {
        if (!alive) return;
        setRoster((prev) =>
          prev.map((m) =>
            m.name === member
              ? {
                  ...m,
                  presence: st as MemberSummary['presence'],
                  activity:
                    st === 'offline'
                      ? 'offline'
                      : m.activity === 'working'
                        ? 'working'
                        : 'online',
                }
              : m,
          ),
        );
      },
      onStatus: (s) => alive && setStatus(s),
      onError: (msg) => alive && setError(msg),
    });
    client.connect();

    return () => {
      alive = false;
      client.close();
    };
  }, [cfg?.team, cfg?.as, cfg?.token]);

  return { envelopes, roster, status, error };
}
