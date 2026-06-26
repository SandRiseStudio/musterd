import type { Envelope, MemberSummary } from '@musterd/protocol';
import { Fragment } from 'react';
import { actTone, clock, initial, kindOf, recipientLabel, rosterIndex } from './format';

/**
 * The legible half of the split-canvas: the team's act stream. Rows arrive newest-last; the last row
 * is the warm "now" live edge. Threaded replies (anything carrying `thread`) indent under a spine.
 */
export function Stream({
  envelopes,
  roster,
}: {
  envelopes: Envelope[];
  roster: MemberSummary[];
}) {
  const idx = rosterIndex(roster);
  const lastId = envelopes.length ? envelopes[envelopes.length - 1]!.id : null;

  return (
    <section className="lc-stream">
      <header className="lc-stream__head">
        <span className="lc-stream__title">TEAM STREAM</span>
        <span className="lc-stream__live">· live</span>
      </header>
      <div className="lc-stream__rows">
        {envelopes.length === 0 && (
          <p className="lc-empty">No communication yet — waiting for the team.</p>
        )}
        {envelopes.map((e) => {
          const isNow = e.id === lastId;
          return (
            <Fragment key={e.id}>
              {isNow && envelopes.length > 1 && (
                <div className="lc-now">
                  <span className="lc-now__dot" />
                  <span className="lc-now__label">now</span>
                  <span className="lc-now__line" />
                </div>
              )}
              <Row env={e} idx={idx} now={isNow} />
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

function Row({
  env,
  idx,
  now,
}: {
  env: Envelope;
  idx: Map<string, MemberSummary>;
  now: boolean;
}) {
  const tone = actTone(env.act);
  const kind = kindOf(env.from, idx);
  const recipient = recipientLabel(env.to);
  const threaded = env.thread != null;
  const body = (
    <div className={`lc-row lc-row--enter${now ? ' lc-row--now' : ''}`} data-tone={tone}>
      <div className="lc-row__head">
        <time className="lc-row__ts">{clock(env.ts)}</time>
        <span className={`lc-chip lc-chip--${kind}`}>
          <span className="lc-chip__avatar">{initial(env.from)}</span>
          <span className="lc-chip__name">{env.from}</span>
        </span>
        <span className={`lc-badge lc-badge--${tone}`}>{env.act}</span>
        {recipient && <span className="lc-row__to">{recipient}</span>}
      </div>
      {env.body && <p className="lc-row__body">{env.body}</p>}
    </div>
  );
  if (!threaded) return body;
  return (
    <div className="lc-thread">
      <span className={`lc-thread__spine lc-thread__spine--${tone}`} />
      {body}
    </div>
  );
}
