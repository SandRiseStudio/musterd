import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import liveCss from '../live/Live.css?url';
import { Constellation } from '../live/Constellation';
import { Stream } from '../live/Stream';
import type { LiveConfig, ConnStatus } from '../live/client';
import { useLiveStream } from '../live/useLiveStream';

export const Route = createFileRoute('/live')({
  head: () => ({
    meta: [{ title: 'musterd — live comms' }],
    links: [{ rel: 'stylesheet', href: liveCss }],
  }),
  component: LivePage,
});

const STORAGE_KEY = 'musterd.live.config';
const DEFAULTS: LiveConfig = { team: '', as: '', token: '' };

function loadSaved(): LiveConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LiveConfig) : null;
  } catch {
    return null;
  }
}

function LivePage() {
  const [form, setForm] = useState<LiveConfig>(DEFAULTS);
  const [cfg, setCfg] = useState<LiveConfig | null>(null);

  // Hydrate the form from localStorage on the client (SSR-safe).
  useEffect(() => {
    const saved = loadSaved();
    if (saved) setForm({ ...DEFAULTS, ...saved });
  }, []);

  const { envelopes, roster, status, error, liveIds } = useLiveStream(cfg);

  const connect = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    }
    setCfg({ ...form });
  };
  const disconnect = () => setCfg(null);

  const connected = cfg != null;
  const canConnect = form.team && form.as && form.token;

  return (
    <main className="lc">
      <header className="lc__topbar">
        <span className="lc__word">musterd</span>
        {connected && <span className="lc__team">/ {cfg!.team}</span>}
        <span className="lc__spacer" />
        <StatusPill status={status} live={roster.filter((m) => m.presence !== 'offline').length} />
      </header>

      {!connected ? (
        <ConnectForm
          form={form}
          onChange={setForm}
          onConnect={connect}
          canConnect={!!canConnect}
          error={error}
        />
      ) : (
        <>
          {error && (
            <div className="lc__error">
              {error} <button onClick={disconnect}>change connection</button>
            </div>
          )}
          <div className="lc__canvas">
            <Constellation roster={roster} envelopes={envelopes} />
            <Stream envelopes={envelopes} roster={roster} liveIds={liveIds} />
          </div>
        </>
      )}
    </main>
  );
}

function StatusPill({ status, live }: { status: ConnStatus; live: number }) {
  const label =
    status === 'live'
      ? `● ${live} live`
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
  form,
  onChange,
  onConnect,
  canConnect,
  error,
}: {
  form: LiveConfig;
  onChange: (c: LiveConfig) => void;
  onConnect: () => void;
  canConnect: boolean;
  error: string | null;
}) {
  const field = (
    key: keyof LiveConfig,
    label: string,
    placeholder: string,
    type = 'text',
  ) => (
    <label className="lc-form__field">
      <span>{label}</span>
      <input
        type={type}
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => onChange({ ...form, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div className="lc-form">
      <div className="lc-form__card">
        <h1 className="lc-form__title">Watch the team, live</h1>
        <p className="lc-form__sub">
          Stream all of a team&apos;s communication from the connected daemon. Reads only. Provision a
          hidden observer seat with <code>musterd team observe &lt;name&gt;</code> so watching never
          shows you on the roster.
        </p>
        {field('team', 'Team', 'alpha')}
        {field('as', 'Observe as', 'your member name')}
        {field('token', 'Token', 'mskd_…', 'password')}
        {error && <p className="lc-form__error">{error}</p>}
        <button className="lc-form__connect" disabled={!canConnect} onClick={onConnect}>
          Connect
        </button>
      </div>
    </div>
  );
}
