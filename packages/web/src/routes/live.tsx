import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock } from '../live/Clock';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { MusterdWord } from '../brand/MusterdWord';
import { AsksStrip } from '../live/AsksStrip';
import { MemberSignInFields, MemberSignInToggle, type AdvancedState } from '../live/MemberSignIn';
import { BoardOverlay, preloadBoard } from '../live/BoardOverlay';
import { OfficeScene } from '../live/OfficeScene';
import { RosterPanel } from '../live/RosterPanel';
import { scrollToMessage, Stream } from '../live/Stream';
import type { LiveConfig } from '../live/client';
import {
  provisionObserver,
  loadObserver,
  saveObserver,
  forgetObserver,
  genObserverName,
  acquireObserver,
  acquireWatchLinkObserver,
} from '../live/client';
import {
  forgetMemberIdentity,
  loadMemberIdentity,
  saveMemberIdentity,
} from '../live/memberIdentity';
import { firehoseSound, roomTone } from '../live/sound';
import { useLiveStream } from '../live/useLiveStream';
import { officeRoom } from '../live/officeRoom';
import { useWorkingOn } from '../live/useWorkingOn';
import { roomEntries } from '../live/workingOn';

export const Route = createFileRoute('/live')({
  head: () => ({
    meta: [{ title: 'musterd — live comms' }],
    links: [
      { rel: 'stylesheet', href: liveCss },
      { rel: 'stylesheet', href: brandCss },
    ],
  }),
  component: LivePage,
});

const TEAM_KEY = 'musterd.live.team';
const COLLAPSE_KEY = 'musterd.live.collapsed';
const COMPANION_KEY = 'musterd.live.companion';

/** Work lives in the in-panel stack — not on nameplates (nick, 2026-07-30 eye test). */
const WORK_CUES: 'hybrid' | 'stack' | 'none' = 'stack';

/** The three live panels, each independently collapsible into a slim rail. */
type PanelId = 'office' | 'roster' | 'stream';
type Collapsed = Record<PanelId, boolean>;
const NO_COLLAPSE: Collapsed = { office: false, roster: false, stream: false };

function LivePage() {
  const [team, setTeam] = useState('');
  const [advanced, setAdvanced] = useState({ open: false, as: '', token: '' });
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  /** True when `cfg` is a real member (ADR 221) rather than an observer or a watch-link seat — the
   *  difference between an office you can act in and one you can only read. */
  const [signedIn, setSignedIn] = useState(false);
  /** Connected via an explicit watch link — read-only by the team's choice, not by accident. */
  const [watchLink, setWatchLink] = useState(false);
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
    // A signed-in human is NOT silently demoted to an observer (ADR 221). Doing that would take the
    // answer buttons away again with no explanation — the exact defect this arc exists to fix — so a
    // dead member credential drops back to watching and says why.
    if (signedIn) {
      recoveredToken.current = staleToken;
      forgetMemberIdentity(team);
      setSignedIn(false);
      setFormError('your sign-in expired — sign in again to answer asks');
      void acquireObserver(team).then(setCfg, (e: unknown) => {
        setFormError(e instanceof Error ? e.message : String(e));
        setCfg(null);
      });
      return;
    }
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
  }, [cfg?.team, cfg?.token, signedIn]);
  const armRecovery = useCallback(() => {
    recoverAttempts.current = 0;
  }, []);

  const stream = useLiveStream(cfg, {
    onCredentialInvalid: recoverObserver,
    onConnected: armRecovery,
  });
  const { envelopes, roster, error, liveIds, daemonBuild, daemonEpoch } = stream;

  // The office overlay's reel: everyone in the room and what they are on. Derived here (not in the
  // scene) so both routes hand the scene the same already-projected shape.
  const board = useWorkingOn(cfg, envelopes);
  const entries = roomEntries(roster, board);

  /**
   * Route back to the credential form (ADR 221). The sign-in fields live on the connect screen, so
   * an already-connected observer has to return to it — which is exactly the dead end the rail was
   * reporting: there was no way back at all once a seat was cached.
   */
  const promptSignIn = useCallback(() => {
    setAdvanced({ open: true, as: '', token: '' });
    setFormError(null);
    setCfg(null);
  }, []);

  /** Become yourself on this browser: remember the identity and reconnect as it (ADR 221). */
  const signIn = useCallback((slug: string, id: { as: string; token: string }) => {
    saveMemberIdentity(slug, id);
    setSignedIn(true);
    setFormError(null);
    setCfg({ team: slug, as: id.as, token: id.token });
  }, []);

  /** Hand the screen back: drop the identity and fall back to watching. The escape hatch a cached
   *  seat never had — before ADR 221 the only way out was clearing localStorage by hand. */
  const signOut = useCallback(() => {
    const slug = cfg?.team;
    if (!slug) return;
    forgetMemberIdentity(slug);
    setSignedIn(false);
    void acquireObserver(slug).then(setCfg, (e: unknown) =>
      setFormError(e instanceof Error ? e.message : String(e)),
    );
  }, [cfg?.team]);

  const watch = async (explicit?: string) => {
    setFormError(null);
    const slug = (explicit ?? team).trim();
    if (!slug) return;
    setTeam(slug);
    window.localStorage.setItem(TEAM_KEY, slug);

    // Advanced: connect as a specific seat the operator supplied (a credential authenticates HTTP + WS).
    if (!explicit && advanced.open && advanced.as.trim() && advanced.token.trim()) {
      signIn(slug, { as: advanced.as.trim(), token: advanced.token.trim() });
      return;
    }

    // A remembered member identity outranks this browser's observer (ADR 221): once you have signed
    // in on this browser you are yourself, on every surface, until you say otherwise.
    const member = loadMemberIdentity(slug);
    if (member) {
      setSignedIn(true);
      setCfg({ team: slug, as: member.as, token: member.token });
      return;
    }

    // Default: reuse this browser's observer seat for the team, or provision one.
    setSignedIn(false);
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

  // The wall's agile board, opened. Two ways in, and they differ only in where the panel comes
  // from: a click on the wall hands us the hotspot's rect and the panel grows out of it, while a
  // `?lane=` deep link has no object to grow from and simply arrives. Either way `boardOpen` is
  // what mounts the overlay — closed, /live pays nothing for the board at all.
  //
  // Declared above the URL hydration below because that effect opens the deep-linked board, and a
  // `const` read before its declaration is a temporal-dead-zone error, not a hoisting nicety.
  //
  // The opener is captured in `openBoard`, before the canvas goes inert (inert blurs it — an
  // activeElement read any later sees only <body>), and focus goes home after the close commits.
  const [boardOrigin, setBoardOrigin] = useState<DOMRect | null>(null);
  const [boardLane, setBoardLane] = useState<string | null>(null);
  const boardOpen = boardOrigin != null || boardLane != null;
  const boardOpener = useRef<HTMLElement | null>(null);
  const openBoard = useCallback((rect: DOMRect) => {
    boardOpener.current = (document.activeElement as HTMLElement | null) ?? null;
    setBoardOrigin(rect);
  }, []);
  const closeBoard = useCallback(() => {
    setBoardOrigin(null);
    setBoardLane(null);
    // A macrotask, not rAF: focus must go home even in a hidden tab (rAF stalls there), and by the
    // time this runs React has committed the close and lifted `inert`.
    window.setTimeout(() => boardOpener.current?.focus?.({ preventScroll: true }), 0);
  }, []);

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
    // `/live?team=…&broadcast=1` is an alias for the broadcast render mode (ADR 157) — the spec URL
    // people will guess and type. Hand it straight to /broadcast, which is a different route by
    // design: it has no advanced-seat path, so streaming can't attach a phantom human presence.
    if (params.get('broadcast') === '1' && urlTeam) {
      window.location.replace(`/broadcast?team=${encodeURIComponent(urlTeam)}`);
      return;
    }
    // `?lane=<id>` — the acceptance deep link, arriving at the office instead of `/board`. The
    // room's own board opens on that lane; there is no hotspot rect to grow out of, so the overlay
    // fades in rather than zooming (see BoardOverlay's `origin`).
    const urlLane = params.get('lane');
    if (urlLane) setBoardLane(urlLane);
    const watchTok = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('w');
    if (urlTeam && urlAs && watchTok) {
      setTeam(urlTeam);
      try {
        window.localStorage.setItem(TEAM_KEY, urlTeam);
      } catch {
        /* private mode */
      }
      setWatchLink(true);
      // A watch link outranks a stored member identity (ADR 221) and is explicitly NOT you: handing
      // the office to someone else must never hand them whoever last signed in on this browser.
      setSignedIn(false);
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
        {/* Operator chrome only. The team name and the connection/present signal moved into the
            office overlay, which carries them over the scene on both /live and /broadcast — repeating
            them a few inches above was the duplication nick asked us to drop (2026-07-24). */}
        <MusterdWord />
        <span className="lc__spacer" />
        {connected && <WatchLinkButton cfg={cfg!} />}
        {connected && <CompanionToggle on={companion} onToggle={toggleCompanion} />}
        {connected && <RoomToneToggle />}
        {connected && <SoundToggle />}
        <Clock />
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
            // A modal means it: while the board overlay is up, the room behind it takes no focus and
            // no clicks (the AsksStrip inert precedent, promoted to page scope).
            inert={boardOpen}
          >
            <OfficeScene
              {...officeRoom(team, stream, { entries, board })}
              collapsed={collapsed.office}
              onCollapse={() => toggleCollapse('office')}
              onActClick={onActClick}
              onBoardOpen={openBoard}
              onBoardHover={preloadBoard}
              // The asks & approvals rail (ADR 149) rides the top of the room itself — the office
              // frames its own asks (nick, 2026-07-28). Still renders nothing until an ask exists.
              topSlot={
                <AsksStrip
                  envelopes={envelopes}
                  roster={roster}
                  cfg={cfg!}
                  watchLink={watchLink}
                  localIdentity={null}
                  onSignIn={promptSignIn}
                  onSignOut={signOut}
                />
              }
              workCues={WORK_CUES}
            />
            <RosterPanel
              roster={roster}
              collapsed={collapsed.roster}
              onCollapse={() => toggleCollapse('roster')}
              daemonBuild={daemonBuild}
              daemonEpoch={daemonEpoch}
            />
            <Stream
              envelopes={envelopes}
              roster={roster}
              liveIds={liveIds}
              collapsed={collapsed.stream}
              onCollapse={() => toggleCollapse('stream')}
            />
          </div>
          {boardOpen && (
            <BoardOverlay
              cfg={cfg}
              roster={roster}
              base={board}
              origin={boardOrigin}
              focusLane={boardLane}
              onClose={closeBoard}
            />
          )}
        </>
      )}
    </main>
  );
}

/**
 * Copy a shareable, read-only **watch link** — an observer credential in the URL fragment (`#w=…`, so
 * it never hits the server). Anyone the team hands it to opens the office as that observer: read-only
 * by construction (ADR 063), fans out to any number of viewers, no account and no per-viewer seat.
 *
 * The link carries a **public-grade** seat of its own (ADR 136), minted on first share — *not* this
 * dashboard's credential. It used to be `cfg.token`, which is the operator's own full-grade seat, so
 * sharing a link shared every DM on the team. A viewer now sees team/broadcast traffic and nothing
 * directed.
 */
function WatchLinkButton({ cfg }: { cfg: LiveConfig }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    const { origin } = window.location;
    let creds;
    try {
      creds = await acquireWatchLinkObserver(cfg.team);
    } catch {
      // Minting failed — do NOT fall back to cfg.token. That fallback is the whole bug: it would
      // silently hand out a full-visibility credential at the exact moment we meant to withhold one.
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2400);
      return;
    }
    const url =
      `${origin}/live?team=${encodeURIComponent(cfg.team)}&as=${encodeURIComponent(creds.name)}` +
      `#w=${encodeURIComponent(creds.token)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this read-only watch link (public traffic only):', url);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      className={`lc__pbtn${copied ? ' lc__pbtn--on' : ''}`}
      onClick={() => void copy()}
      title={
        failed
          ? 'Could not mint a watch-link seat — copy it from the daemon host'
          : 'Copy a shareable read-only watch link (public traffic only — no DMs, no account)'
      }
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
 * Room tone: the sound of the office being *there* — ventilation, a low building hum, and somebody
 * typing a few desks away. Its own switch rather than a mode of the one above, because the two
 * answer different questions (see the room-tone block in `sound.ts`): a viewer may reasonably want
 * arrivals audible in a silent room, or a lived-in room that never pings at them.
 *
 * Default OFF, like the cues, and for the same reason — the click IS the gesture that lets the
 * AudioContext start. A preference restored from an earlier session cannot start itself, so this
 * button is also where `resumeIfEnabled` gets its chance.
 */
function RoomToneToggle() {
  const [on, setOn] = useState(() => roomTone.enabled);
  // A stored `on` from a previous visit needs a gesture before it can make a sound. Any click
  // anywhere on the page is gesture enough, and one is cheaper to catch than to ask for.
  useEffect(() => {
    if (!roomTone.enabled) return;
    const wake = () => roomTone.resumeIfEnabled();
    window.addEventListener('pointerdown', wake, { once: true });
    return () => window.removeEventListener('pointerdown', wake);
  }, []);
  const toggle = () => {
    const next = !on;
    roomTone.setEnabled(next);
    setOn(next);
  };
  return (
    <button
      type="button"
      className={`lc__sound lc__sound--room${on ? ' lc__sound--on' : ''}`}
      onClick={toggle}
      aria-pressed={on}
      title={on ? 'Silence the room' : 'Play the room: quiet office ambience'}
    >
      {/* Three rising bars behind a mug — "the room is running", not "a message arrived". Muted, the
          bars flatten to one line: the room is still there, it just is not making a sound. */}
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {on ? (
          <path d="M2.5 9.5v2M5 7.5v4M7.5 5.5v6" />
        ) : (
          <path d="M2.5 11.5h5.2" />
        )}
        <path d="M10.5 6.5h3.2v3a2 2 0 0 1-2 2h-1.2z" />
        <path d="M13.7 7.5h.6a1.1 1.1 0 0 1 0 2.2h-.6" />
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
  advanced: AdvancedState;
  onAdvanced: (a: AdvancedState) => void;
  onWatch: () => void;
  provisioning: boolean;
  error: string | null;
}) {
  return (
    <div className="lc-form">
      <div className="lc-form__card">
        <h1 className="lc-form__title">Watch the team, live</h1>
        <p className="lc-form__sub">
          Enter a team to stream all of its communication. A hidden read-only observer seat is
          created for you — watching never shows you on the roster.
        </p>
        <label className="lc-form__field">
          <span>Team</span>
          {/* No autoFocus. This form is the FIRST thing on the page, and focusing it on load drops a
              screen-reader user straight into a text field — past the heading and past the sentence
              above explaining that watching creates a hidden observer seat and never puts them on
              the roster. That is a privacy fact they are entitled to hear before they start typing.
              The page is a single form, so a keyboard user is one Tab away regardless. */}
          <input
            type="text"
            value={team}
            placeholder="alpha"
            onChange={(e) => onTeam(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onWatch()}
          />
        </label>

        <MemberSignInFields advanced={advanced} onAdvanced={onAdvanced} />

        {error && <p className="lc-form__error">{error}</p>}

        <button
          className="lc-form__connect"
          disabled={!team.trim() || provisioning}
          onClick={onWatch}
        >
          {provisioning && <span className="lc-spinner" aria-hidden="true" />}
          {provisioning ? 'Provisioning…' : 'Watch live'}
        </button>

        <MemberSignInToggle advanced={advanced} onAdvanced={onAdvanced} />
      </div>
    </div>
  );
}
