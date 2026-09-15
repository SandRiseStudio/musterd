import type { Envelope, MemberSummary, WorkingHours } from '@musterd/protocol';
import { useEffect, useRef, useState } from 'react';
import {
  LiveClient,
  fetchHistory,
  fetchRoster,
  isStaleCredential,
  type ConnStatus,
  type LiveConfig,
} from './client';
import { ensureBuildSync } from './buildSync';
import { firehoseSound } from './sound';
import { capNewest } from './window';

/** Consecutive roster-refetch failures before the roster admits it is frozen. */
const ROSTER_STALE_AFTER = 3;

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
  teamWorkingHours: WorkingHours | null;
  status: ConnStatus;
  error: string | null;
  /** Ids that arrived live over the socket (vs the initial backfill) — drives the typewriter. */
  liveIds: Set<string>;
  /** The daemon's build ref (ADR 130/135) — an operator detail, surfaced in the roster tooltip. */
  daemonBuild?: string | undefined;
  /** The daemon's feature epoch (ADR 148) — the reference the roster compares member epochs against
   *  to render a "behind" hint. Undefined until /health answers (skew simply doesn't render). */
  daemonEpoch?: number | undefined;
  /** Roster rows this bundle could not read — seats carrying a value newer than this build (see
   *  `fetchRoster`). The roster names the gap instead of pretending the team is smaller than it is. */
  rosterUnreadable: number;
  /** The roster refetch has failed repeatedly, so the seats on screen are frozen at their last good
   *  read. Silence here used to be total: the presence refetch swallowed every failure, so a persistently
   *  broken roster looked exactly like a quiet team (the ADR 230 shape). */
  rosterStale: boolean;
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
  useEffect(() => {
    hooksRef.current = hooks;
  });
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  // The daemon's build ref (ADR 130/135) — an operator detail (roster tooltip).
  const [daemonBuild, setDaemonBuild] = useState<string | undefined>(undefined);
  // The daemon's feature epoch (ADR 148) — the reference the roster compares member epochs against.
  const [daemonEpoch, setDaemonEpoch] = useState<number | undefined>(undefined);
  const [roster, setRoster] = useState<MemberSummary[]>([]);
  const [teamWorkingHours, setTeamWorkingHours] = useState<WorkingHours | null>(null);
  const [status, setStatus] = useState<ConnStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  const [rosterUnreadable, setRosterUnreadable] = useState(0);
  const [rosterStale, setRosterStale] = useState(false);
  // Consecutive failed roster refetches. One is ordinary (a bounce, a dropped request); a run of them
  // means the roster on screen is frozen, and that is worth saying out loud.
  const rosterFailsRef = useRef(0);
  // Ids we've already sounded — at-least-once delivery + reconnect replays must not double-chime.
  const chimedRef = useRef<Set<string>>(new Set());

  // Reconnects are driven by the credential TRIPLE, never by `cfg`'s object identity — the route
  // rebuilds that object on plenty of renders that mean nothing to the connection, and re-running
  // this effect tears down a live socket and re-provisions. Rebuilding the triple into a local
  // `conn` is what lets the dependency list be honest about that instead of suppressing the rule:
  // everything the effect reads is now in its deps.
  const team = cfg?.team;
  const as = cfg?.as;
  const token = cfg?.token;

  // Stale-page convergence (buildSync.ts): every live surface — /live and /broadcast alike — keeps
  // itself on the build the daemon serves. Idempotent and inert in dev; independent of credentials,
  // because a page stuck on a login error is still a page worth un-staling.
  useEffect(() => {
    ensureBuildSync();
  }, []);

  useEffect(() => {
    if (!team || !as || !token) {
      setStatus('idle');
      return;
    }
    const cfg: LiveConfig = { team, as, token };
    let alive = true;
    setEnvelopes([]);
    setLiveIds(new Set());
    setError(null);
    setStatus('connecting');

    // Dedupe by id against the *previous array* only — the updater must stay pure (no external
    // mutation), or React StrictMode's double-invoke commits the second (empty) result. Delivery is
    // at-least-once and a backfilled message can also arrive live, so dedup is load-bearing.
    // Capped to the newest MAX_ENVELOPES: a wall-mounted dashboard accretes live arrivals forever,
    // and an unbounded array is a slow leak (the stream's DOM is already windowed on top of this).
    const add = (incoming: Envelope[]) => {
      setEnvelopes((prev) => {
        const have = new Set(prev.map((e) => e.id));
        const fresh = incoming.filter((e) => !have.has(e.id));
        if (fresh.length === 0) return prev;
        return capNewest([...prev, ...fresh].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)));
      });
    };

    // The daemon's build ref + feature epoch (ADR 135/148): one same-origin fetch per mount, best-effort
    // — an unreachable daemon leaves both undefined and the roster skew hint simply never renders.
    fetch('/health', { signal: AbortSignal.timeout(2500) })
      .then((r) => r.json())
      .then((h: { build?: string; epoch?: number }) => {
        if (!alive) return;
        if (h.build) setDaemonBuild(h.build);
        if (typeof h.epoch === 'number') setDaemonEpoch(h.epoch);
      })
      .catch(() => {});

    // Backfill (roster + history) in parallel, then the socket live-tails on top.
    Promise.all([fetchRoster(cfg), fetchHistory(cfg, { limit: 200 })])
      .then(([r, h]) => {
        if (!alive) return;
        setRoster(r.members);
        setTeamWorkingHours(r.working_hours);
        setRosterUnreadable(r.unreadable);
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
        // history over the socket), and once per id. The engine itself no-ops when muted, and the
        // façade drops cues while the tab is hidden (broadcast excepted) — see firehoseSound.chime.
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
          .then((r) => {
            if (!alive) return;
            setRoster(r.members);
            setTeamWorkingHours(r.working_hours);
            setRosterUnreadable(r.unreadable);
            rosterFailsRef.current = 0;
            setRosterStale(false);
          })
          .catch(() => {
            // This used to be `.catch(() => {})`, which made a persistently broken roster
            // indistinguishable from a calm one — the seats simply froze at their last good read and
            // nothing on screen said so. A single failure is still ignored (bounces happen); a run of
            // them raises a quiet stale flag rather than an error banner, because the timeline beside
            // it is still live and the page is still worth reading.
            if (!alive) return;
            rosterFailsRef.current += 1;
            if (rosterFailsRef.current >= ROSTER_STALE_AFTER) setRosterStale(true);
          });
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
  }, [team, as, token]);

  return {
    envelopes,
    roster,
    teamWorkingHours,
    status,
    error,
    liveIds,
    daemonBuild,
    daemonEpoch,
    rosterUnreadable,
    rosterStale,
  };
}
