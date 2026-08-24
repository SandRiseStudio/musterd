import { seedInActiveTray, type Seed } from '@musterd/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveConfig } from './client';
import { fetchSeeds } from './seedClient';

export function traySeeds(seeds: Seed[], history: boolean): Seed[] {
  return history ? seeds : seeds.filter(seedInActiveTray);
}

export function seedLaneHref(laneId: string, team: string): string {
  return `/live?team=${encodeURIComponent(team)}&lane=${encodeURIComponent(laneId)}`;
}

export function seedResultSections(seed: Seed): Array<{ label: string; body: string }> {
  const brief = seed.final_brief;
  if (!brief) return [];
  return [
    { label: 'Problem', body: brief.problem },
    { label: 'Context', body: brief.context },
    { label: 'Evidence', body: brief.external_evidence.join('\n') },
    ...brief.approaches.map(({ approach, tradeoffs }) => ({
      label: 'Approach',
      body: `${approach} — ${tradeoffs}`,
    })),
    { label: 'Constraints', body: brief.constraints.join('\n') },
    { label: 'Risks', body: brief.risks.join('\n') },
    { label: 'Unknowns', body: brief.unknowns.join('\n') },
    { label: 'Recommendation', body: brief.recommendation },
    {
      label: 'Proposed Lane',
      body: `${brief.proposed_lane.title} — ${brief.proposed_lane.detail}`,
    },
  ];
}

export function SeedsTray({
  cfg,
  activityKey,
  onClose,
}: {
  cfg: LiveConfig;
  /** The latest firehose id; a Seed promotion emits an ordinary Lane activity, so refetch it. */
  activityKey?: string | undefined;
  onClose: () => void;
}) {
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [history, setHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void fetchSeeds(cfg)
      .then((next) => {
        if (!alive) return;
        setSeeds(next);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cfg.team, cfg.as, cfg.token, activityKey]);

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  const visible = useMemo(() => traySeeds(seeds, history), [seeds, history]);

  return (
    <div className="lc-seeds" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className="lc-seeds__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Shared Seeds — ${cfg.team}`}
        tabIndex={-1}
      >
        <header className="lc-seeds__head">
          <div>
            <span className="lc-seeds__eyebrow">TEAM IDEAS</span>
            <h2>Shared Seeds</h2>
          </div>
          <button className="lc-seeds__close" onClick={onClose} aria-label="Close Shared Seeds">
            ×
          </button>
        </header>
        <div className="lc-seeds__tabs" role="group" aria-label="Seed view">
          <button className={!history ? 'is-on' : ''} aria-pressed={!history} onClick={() => setHistory(false)}>
            active
          </button>
          <button className={history ? 'is-on' : ''} aria-pressed={history} onClick={() => setHistory(true)}>
            history
          </button>
          <span>{visible.length}</span>
        </div>
        <div className="lc-seeds__body" aria-live="polite">
          {loading && seeds.length === 0 && <p className="lc-seeds__empty">Loading Shared Seeds…</p>}
          {error && <p className="lc-seeds__error">Seeds paused — {error}</p>}
          {!loading && !error && visible.length === 0 && (
            <p className="lc-seeds__empty">
              {history
                ? 'No Seeds captured yet.'
                : "No active Seeds — send an idea through the Team's Slack capture."}
            </p>
          )}
          {visible.map((seed) => (
            <article key={seed.id} className={`lc-seed lc-seed--${seed.state}`}>
              <div className="lc-seed__meta">
                <span className="lc-seed__state">{seed.state.replace('_', ' ')}</span>
                <time dateTime={new Date(seed.captured_at).toISOString()}>
                  {new Date(seed.captured_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              </div>
              <p className="lc-seed__idea">{seed.body}</p>
              <div className="lc-seed__byline">
                <span>from {seed.submitted_by}</span>
                {seed.explorer && <span>explored by {seed.explorer}</span>}
              </div>
              {seed.thread.length > 0 && (
                <div className="lc-seed__thread">
                  {seed.thread.map((entry) => (
                    <p key={entry.id}>
                      <b>{entry.kind.replace('_', ' ')}</b> · {entry.by}: {entry.body}
                    </p>
                  ))}
                </div>
              )}
              {seed.conclusion && <p className="lc-seed__conclusion">{seed.conclusion}</p>}
              {history && seed.final_brief && (
                <details className="lc-seed__result">
                  <summary>Exploration result</summary>
                  {seedResultSections(seed).map((section, index) => (
                    <div key={`${section.label}-${index}`}>
                      <b>{section.label}</b>
                      <p>{section.body}</p>
                    </div>
                  ))}
                </details>
              )}
              {history && seed.promotion && (
                <p className="lc-seed__promotion">
                  {seed.promotion.kind} promotion
                  {seed.promotion.research_skipped ? ' · research skipped' : ''}
                </p>
              )}
              {history && seed.linked_lane_id && (
                <a className="lc-seed__lane" href={seedLaneHref(seed.linked_lane_id, cfg.team)}>
                  Open Lane {seed.linked_lane_id} →
                </a>
              )}
            </article>
          ))}
        </div>
        <footer className="lc-seeds__foot">Read-only here · explore from CLI or an agent Surface</footer>
      </div>
    </div>
  );
}
