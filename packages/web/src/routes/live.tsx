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
const observerKey = (team: string) => `musterd.live.observer.${team}`;

interface ObserverCreds {
  name: string;
  token: string;
}

function loadObserver(team: string): ObserverCreds | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(observerKey(team));
    return raw ? (JSON.parse(raw) as ObserverCreds) : null;
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

  const { envelopes, roster, status, error, liveIds } = useLiveStream(cfg);

  const watch = async (explicit?: string) => {
    setFormError(null);
    const slug = (explicit ?? team).trim();
    if (!slug) return;
    setTeam(slug);
    window.localStorage.setItem(TEAM_KEY, slug);

    // Advanced: connect as a specific seat the operator supplied.
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
        const token = await provisionObserver(slug, name);
        creds = { name, token };
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
          <div className="lc__canvas">
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
