import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import liveCss from '../live/Live.css?url';
import { ConstellationGL } from '../live/ConstellationGL';
import { RosterPanel } from '../live/RosterPanel';
import { Stream } from '../live/Stream';
import type { LiveConfig, ConnStatus } from '../live/client';
import { provisionObserver } from '../live/client';
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
const PANEL_KEY = 'musterd.live.panel';
/** Office panel presentation: normal (in the split), collapsed (hidden), or companion (fills the window). */
type PanelMode = 'normal' | 'collapsed' | 'companion';
// `.v2` = credential-based observer (ADR 077 claim handshake); bumping the key drops any legacy
// token-based creds so the next Watch re-provisions with a credential.
const observerKey = (team: string) => `musterd.live.observer.v2.${team}`;

interface ObserverCreds {
  name: string;
  /** The observer seat's credential (mscr_) — the single v0.3 auth secret (HTTP + WS claim). */
  token: string;
}

function loadObserver(team: string): ObserverCreds | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(observerKey(team));
    if (!raw) return null;
    const creds = JSON.parse(raw) as ObserverCreds;
    return creds && creds.token ? creds : null;
  } catch {
    return null;
  }
}
function saveObserver(team: string, creds: ObserverCreds) {
  window.localStorage.setItem(observerKey(team), JSON.stringify(creds));
}
function forgetObserver(team: string) {
  window.localStorage.removeItem(observerKey(team));
}
function genObserverName(): string {
  return 'web-' + Math.random().toString(36).slice(2, 8);
}

function LivePage() {
  const [team, setTeam] = useState('');
  const [advanced, setAdvanced] = useState({ open: false, as: '', token: '' });
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelMode>('normal');

  const setPanelMode = (m: PanelMode) => {
    setPanel(m);
    try {
      window.localStorage.setItem(PANEL_KEY, m);
    } catch {
      /* private mode — mode just won't persist */
    }
  };

  const { envelopes, roster, status, error, liveIds } = useLiveStream(cfg);

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

  // Hydrate from the URL (?team=… is a shareable watch link → auto-connect) or the last team
  // (SSR-safe; runs once on the client).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlTeam = new URLSearchParams(window.location.search).get('team');
    if (urlTeam) {
      void watch(urlTeam);
    } else {
      setTeam(window.localStorage.getItem(TEAM_KEY) ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore the saved office panel mode (SSR-safe; once on the client).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(PANEL_KEY);
    if (saved === 'collapsed' || saved === 'companion' || saved === 'normal') setPanel(saved);
  }, []);

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
        {connected && <PanelControls mode={panel} onMode={setPanelMode} />}
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
          <div className={`lc__canvas lc__canvas--${panel}`}>
            <ConstellationGL roster={roster} envelopes={envelopes} liveIds={liveIds} />
            <RosterPanel roster={roster} />
            <Stream envelopes={envelopes} roster={roster} liveIds={liveIds} />
          </div>
        </>
      )}
    </main>
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
 * Office panel controls: collapse/expand the office within the split, and a "companion" toggle that
 * makes the office fill the browser window (not OS fullscreen) with the roster/stream tucked away.
 */
function PanelControls({ mode, onMode }: { mode: PanelMode; onMode: (m: PanelMode) => void }) {
  const collapsed = mode === 'collapsed';
  const companion = mode === 'companion';
  return (
    <>
      <button
        type="button"
        className="lc__pbtn"
        onClick={() => onMode(collapsed ? 'normal' : 'collapsed')}
        aria-pressed={collapsed}
        title={collapsed ? 'Show the office' : 'Collapse the office'}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="1.6" />
          <path d="M6.5 3v10" />
          {collapsed ? <path d="M9 6.2 10.8 8 9 9.8" /> : <path d="M10.8 6.2 9 8l1.8 1.8" />}
        </svg>
      </button>
      <button
        type="button"
        className={`lc__pbtn${companion ? ' lc__pbtn--on' : ''}`}
        onClick={() => onMode(companion ? 'normal' : 'companion')}
        aria-pressed={companion}
        title={companion ? 'Exit companion mode' : 'Companion mode — fill the window'}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          {companion ? (
            <path d="M6.5 3v3.5H3M9.5 3v3.5H13M6.5 13V9.5H3M9.5 13V9.5H13" />
          ) : (
            <path d="M3 6.5V3h3.5M13 6.5V3H9.5M3 9.5V13h3.5M13 9.5V13H9.5" />
          )}
        </svg>
      </button>
    </>
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
