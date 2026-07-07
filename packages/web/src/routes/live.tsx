import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import liveCss from '../live/Live.css?url';
import { OfficeScene } from '../live/OfficeScene';
import { RosterPanel } from '../live/RosterPanel';
import { scrollToMessage, Stream } from '../live/Stream';
import type { LiveConfig, ConnStatus } from '../live/client';
import {
  provisionObserver,
  loadObserver,
  saveObserver,
  forgetObserver,
  genObserverName,
} from '../live/client';
import { firehoseSound } from '../live/sound';
import { useLiveStream } from '../live/useLiveStream';

export const Route = createFileRoute('/live')({
  head: () => ({
    meta: [{ title: 'musterd — live comms' }],
    links: [{ rel: 'stylesheet', href: liveCss }],
  }),
  component: LivePage,
});

const TEAM_KEY = 'musterd.live.team';
const COLLAPSE_KEY = 'musterd.live.collapsed';
const COMPANION_KEY = 'musterd.live.companion';

/** The three live panels, each independently collapsible into a slim rail. */
type PanelId = 'office' | 'roster' | 'stream';
type Collapsed = Record<PanelId, boolean>;
const NO_COLLAPSE: Collapsed = { office: false, roster: false, stream: false };

function LivePage() {
  const [team, setTeam] = useState('');
  const [advanced, setAdvanced] = useState({ open: false, as: '', token: '' });
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Collapsed>(NO_COLLAPSE);
  const [companion, setCompanion] = useState(false);

  const toggleCollapse = (id: PanelId) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* private mode — collapse state just won't persist */
      }
      return next;
    });
  };

  const toggleCompanion = () => {
    setCompanion((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COMPANION_KEY, next ? '1' : '');
      } catch {
        /* private mode */
      }
      return next;
    });
  };

  // Auto-recovery for a stale observer credential (a wiped DB or an expired 24h observer TTL, ADR 064):
  // instead of dead-ending on "invalid … credential", drop the cached credential and provision a fresh
  // observer, then reconnect. `recoveredToken` dedupes the HTTP-401 + WS-refused double-signal for one
  // credential; `attempts` is a backstop so a persistently-failing provision falls back to the form
  // rather than looping. `onConnected` re-arms both once a fresh credential works.
  const recoveredToken = useRef<string | null>(null);
  const recoverAttempts = useRef(0);
  const recoverObserver = useCallback(() => {
    const team = cfg?.team;
    const staleToken = cfg?.token;
    if (!team || !staleToken) return;
    if (recoveredToken.current === staleToken) return; // already handling this exact credential
    if (recoverAttempts.current >= 2) {
      forgetObserver(team);
      setFormError('the live observer keeps being rejected — reconnect or check the daemon');
      setCfg(null);
      return;
    }
    recoveredToken.current = staleToken;
    recoverAttempts.current += 1;
    forgetObserver(team);
    void (async () => {
      try {
        const name = genObserverName();
        const credential = await provisionObserver(team, name);
        saveObserver(team, { name, token: credential });
        setCfg({ team, as: name, token: credential }); // reconnect with the fresh observer
      } catch (e) {
        setFormError(e instanceof Error ? e.message : String(e));
        setCfg(null);
      }
    })();
  }, [cfg?.team, cfg?.token]);
  const armRecovery = useCallback(() => {
    recoverAttempts.current = 0;
  }, []);

  const { envelopes, roster, status, error, liveIds } = useLiveStream(cfg, {
    onCredentialInvalid: recoverObserver,
    onConnected: armRecovery,
  });

  const watch = async (explicit?: string) => {
    setFormError(null);
    const slug = (explicit ?? team).trim();
    if (!slug) return;
    setTeam(slug);
    window.localStorage.setItem(TEAM_KEY, slug);

    // Advanced: connect as a specific seat the operator supplied (a credential authenticates HTTP + WS).
    if (!explicit && advanced.open && advanced.as.trim() && advanced.token.trim()) {
      setCfg({ team: slug, as: advanced.as.trim(), token: advanced.token.trim() });
      return;
    }

    // Default: reuse this browser's observer seat for the team, or provision one.
    let creds = loadObserver(slug);
    if (!creds) {
      setProvisioning(true);
      try {
        const name = genObserverName();
        const credential = await provisionObserver(slug, name);
        creds = { name, token: credential };
        saveObserver(slug, creds);
      } catch (e) {
        setFormError(e instanceof Error ? e.message : String(e));
        setProvisioning(false);
        return;
      }
      setProvisioning(false);
    }
    setCfg({ team: slug, as: creds.name, token: creds.token });
  };

  // Hydrate from the URL or the last team (SSR-safe; runs once on the client). Two URL shapes:
  //   /live?team=<slug>&as=<observer>#w=<credential>  — a shared, team-controlled watch link: connect
  //     straight to that one read-only observer seat (fans out, no per-viewer seat). The credential
  //     rides the URL *fragment* so it never reaches the server or its logs.
  //   /live?team=<slug>                               — auto-provision this browser's own observer.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const urlTeam = params.get('team');
    const urlAs = params.get('as');
    const watchTok = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('w');
    if (urlTeam && urlAs && watchTok) {
      setTeam(urlTeam);
      try {
        window.localStorage.setItem(TEAM_KEY, urlTeam);
      } catch {
        /* private mode */
      }
      setCfg({ team: urlTeam, as: urlAs, token: watchTok });
    } else if (urlTeam) {
      void watch(urlTeam);
    } else {
      setTeam(window.localStorage.getItem(TEAM_KEY) ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore saved panel collapse + companion state (SSR-safe; once on the client).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(COLLAPSE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Collapsed>;
        setCollapsed({
          office: !!saved.office,
          roster: !!saved.roster,
          stream: !!saved.stream,
        });
      }
    } catch {
      /* ignore malformed persisted state */
    }
    setCompanion(window.localStorage.getItem(COMPANION_KEY) === '1');
  }, []);

  // A clicked office speech bubble navigates to its act in the stream. If the stream rail is collapsed,
  // expand it first and let the expand transition land before scrolling — one smooth motion, no jump cut.
  const onActClick = useCallback(
    (id: string) => {
      if (collapsed.stream) {
        toggleCollapse('stream');
        window.setTimeout(() => scrollToMessage(id), 380);
      } else {
        scrollToMessage(id);
      }
    },
    [collapsed.stream],
  );

  // On a terminal connection error (e.g. a stale observer token after a daemon reset), drop the
  // stored observer so the next Watch re-provisions a fresh one.
  const reset = () => {
    if (cfg) forgetObserver(cfg.team);
    setCfg(null);
  };

  const connected = cfg != null;

  return (
    <main className="lc">
      <header className="lc__topbar">
        <span className="lc__word">musterd</span>
        {connected && <span className="lc__team">/ {cfg!.team}</span>}
        <span className="lc__spacer" />
        {connected && <WatchLinkButton cfg={cfg!} />}
        {connected && <CompanionToggle on={companion} onToggle={toggleCompanion} />}
        {connected && <SoundToggle />}
        <StatusPill status={status} live={roster.filter((m) => m.presence !== 'offline').length} />
      </header>

      {!connected ? (
        <ConnectForm
          team={team}
          onTeam={setTeam}
          advanced={advanced}
          onAdvanced={setAdvanced}
          onWatch={() => void watch()}
          provisioning={provisioning}
          error={formError}
        />
      ) : (
        <>
          {error && (
            <div className="lc__error">
              {error} <button onClick={reset}>reset &amp; reconnect</button>
            </div>
          )}
          <div
            className={
              `lc__canvas${companion ? ' lc__canvas--companion' : ''}` +
              `${collapsed.office ? ' is-office-collapsed' : ''}` +
              `${collapsed.roster ? ' is-roster-collapsed' : ''}` +
              `${collapsed.stream ? ' is-stream-collapsed' : ''}`
            }
          >
            <OfficeScene
              roster={roster}
              envelopes={envelopes}
              liveIds={liveIds}
              collapsed={collapsed.office}
              onCollapse={() => toggleCollapse('office')}
              onActClick={onActClick}
            />
            <RosterPanel
              roster={roster}
              collapsed={collapsed.roster}
              onCollapse={() => toggleCollapse('roster')}
            />
            <Stream
              envelopes={envelopes}
              roster={roster}
              liveIds={liveIds}
              collapsed={collapsed.stream}
              onCollapse={() => toggleCollapse('stream')}
            />
          </div>
        </>
      )}
    </main>
  );
}

/**
 * Copy a shareable, read-only **watch link** — the current observer seat's credential in the URL
 * fragment (`#w=…`, so it never hits the server). Anyone the team hands it to opens the office as this
 * same observer: read-only by construction (ADR 063), fans out to any number of viewers, no account
 * and no per-viewer seat. This is the "team-controlled" way to let non-musterd people watch.
 */
function WatchLinkButton({ cfg }: { cfg: LiveConfig }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const { origin } = window.location;
    const url =
      `${origin}/live?team=${encodeURIComponent(cfg.team)}&as=${encodeURIComponent(cfg.as)}` +
      `#w=${encodeURIComponent(cfg.token)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this read-only watch link:', url);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      className={`lc__pbtn${copied ? ' lc__pbtn--on' : ''}`}
      onClick={() => void copy()}
      title="Copy a shareable read-only watch link (anyone can watch — no account)"
    >
      {copied ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5 6.5 11.5 12.5 5" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6.5 9.5 9.5 6.5M7 4.5 8.4 3a2.6 2.6 0 0 1 3.7 3.7L10.6 8.2M9 11.5 7.6 13a2.6 2.6 0 0 1-3.7-3.7L5.4 7.8" />
        </svg>
      )}
    </button>
  );
}

/**
 * Mute/unmute the firehose's per-act sound cues. Default OFF: enabling is the user gesture that lets
 * the AudioContext start (browser autoplay policy), and a one-shot blip confirms it's live.
 */
function SoundToggle() {
  const [on, setOn] = useState(() => firehoseSound.enabled);
  const toggle = () => {
    const next = !on;
    firehoseSound.setEnabled(next);
    setOn(next);
    if (next) firehoseSound.chime('handoff'); // a friendly two-note "sound is on" confirmation
  };
  return (
    <button
      type="button"
      className={`lc__sound${on ? ' lc__sound--on' : ''}`}
      onClick={toggle}
      aria-pressed={on}
      title={on ? 'Mute arrival sounds' : 'Play a sound on every new message'}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 6.2h2.2L8.3 3.6v8.8L5.2 9.8H3z" />
        {on ? (
          <path d="M10.4 5.6a3.2 3.2 0 0 1 0 4.8M12.2 4a5.6 5.6 0 0 1 0 8" />
        ) : (
          <path d="m10.8 6 3.4 4M14.2 6l-3.4 4" />
        )}
      </svg>
    </button>
  );
}

/**
 * Companion toggle: make the office fill the browser window (not OS fullscreen) with the roster/stream
 * tucked away. Per-panel collapse now lives inside each panel's own header (see PanelChrome).
 */
function CompanionToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`lc__pbtn${on ? ' lc__pbtn--on' : ''}`}
      onClick={onToggle}
      aria-pressed={on}
      title={on ? 'Exit companion mode' : 'Companion mode — office fills the window'}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {on ? (
          <path d="M6.5 3v3.5H3M9.5 3v3.5H13M6.5 13V9.5H3M9.5 13V9.5H13" />
        ) : (
          <path d="M3 6.5V3h3.5M13 6.5V3H9.5M3 9.5V13h3.5M13 9.5V13H9.5" />
        )}
      </svg>
    </button>
  );
}

function StatusPill({ status, live }: { status: ConnStatus; live: number }) {
  const label =
    status === 'live'
      ? `${live} live`
      : status === 'connecting'
        ? 'connecting…'
        : status === 'reconnecting'
          ? 'reconnecting…'
          : status === 'error'
            ? 'error'
            : status === 'closed'
              ? 'disconnected'
              : 'idle';
  return <span className={`lc__status lc__status--${status}`}>{label}</span>;
}

function ConnectForm({
  team,
  onTeam,
  advanced,
  onAdvanced,
  onWatch,
  provisioning,
  error,
}: {
  team: string;
  onTeam: (v: string) => void;
  advanced: { open: boolean; as: string; token: string };
  onAdvanced: (a: { open: boolean; as: string; token: string }) => void;
  onWatch: () => void;
  provisioning: boolean;
  error: string | null;
}) {
  return (
    <div className="lc-form">
      <div className="lc-form__card">
        <h1 className="lc-form__title">Watch the team, live</h1>
        <p className="lc-form__sub">
          Enter a team to stream all of its communication. A hidden read-only observer seat is created
          for you — watching never shows you on the roster.
        </p>
        <label className="lc-form__field">
          <span>Team</span>
          <input
            type="text"
            value={team}
            placeholder="alpha"
            autoFocus
            onChange={(e) => onTeam(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onWatch()}
          />
        </label>

        {advanced.open && (
          <>
            <label className="lc-form__field">
              <span>Observe as (seat)</span>
              <input
                type="text"
                value={advanced.as}
                placeholder="your seat name"
                onChange={(e) => onAdvanced({ ...advanced, as: e.target.value })}
              />
            </label>
            <label className="lc-form__field">
              <span>Credential</span>
              <input
                type="password"
                value={advanced.token}
                placeholder="mscr_… or mskey_…"
                onChange={(e) => onAdvanced({ ...advanced, token: e.target.value })}
              />
            </label>
          </>
        )}

        {error && <p className="lc-form__error">{error}</p>}

        <button className="lc-form__connect" disabled={!team.trim() || provisioning} onClick={onWatch}>
          {provisioning && <span className="lc-spinner" aria-hidden="true" />}
          {provisioning ? 'Provisioning…' : 'Watch live'}
        </button>

        <button
          className="lc-form__advanced"
          onClick={() => onAdvanced({ ...advanced, open: !advanced.open })}
        >
          {advanced.open ? 'Use an auto observer instead' : 'Advanced — connect as a specific seat'}
        </button>
      </div>
    </div>
  );
}
