import './WhatIs.css';

/**
 * The what-is section: the four load-bearing ideas a stranger needs, and nothing else. The fourth
 * (who did what) was added 2026-09-16 under ADR 320 decision 5: the room now arrives afraid of
 * agents nobody owns, and the answer is names and an observed record, never a containment claim.
 * The heading is the qualified category phrase of ADR 320 decision 4 — never the bare term.
 *
 * The wedge note ("How priorities are decided") used to sit under these cards and was CUT on
 * 2026-09-16 (lane 01M2NS50HC, nick's call). Two reasons, and the second is the disqualifying one.
 *
 * It was the wrong content for the reader. This page's visitor is deciding whether to run one
 * command; how WE weigh work against a wedge is roadmap rationale, addressed to contributors. It
 * still reads that way in ROADMAP.md, which is why `WEDGE` lives on in content/site.ts and
 * `gen-roadmap` still renders it — the constant was never the problem, the placement was. There is
 * no /roadmap on this origin to move it to either (404, absent from PUBLIC_ALLOW).
 *
 * And it put a bare "about 79% of multi-agent failures" in front of a stranger as fact. The figure
 * is MAST's (arXiv 2503.13657) — a failure TAXONOMY over other people's multi-agent systems, not a
 * measurement of musterd and not a transferable multiplier. ADR 320's "what this is not" bars
 * exactly that move for AgentRadio's 62.1%; the same rule reaches this. The three refs beside it
 * pointed at our own docs, so a reader who wanted the source could not reach it from here. The
 * body now names and links MAST wherever it is rendered, so the number is attributable on the
 * surface that keeps it.
 *
 * The cards make the argument without a borrowed number, which is the test this section now has
 * to pass on its own.
 *
 * The fourth card was RE-SCOPED on 2026-09-18 (lane 01M2NS50HC, docs/design/homepage-copy-spec.md
 * §2/§4.4). #1537 scoped this card's first sentence and left its heading and its tail standing, so
 * the page scoped the claim in the middle of a card that overclaimed at both ends:
 *
 *   - The heading posed who-did-what as a rhetorical question, which promises exactly the
 *     containment ADR 320 decision 5 refuses. Tool use IS the question, and musterd never sees it.
 *     Replaced by ADR 320 §5a's canonical scoped statement — which also moves the scope to where a
 *     scanner reads it, rather than leaving it in a body they skip.
 *   - The body claimed, unscoped, that the record holds what the harness saw. That reads as a
 *     tool-call transcript. What is attested is which model occupied a seat, at connect time
 *     (ADR 158/163), so the sentence now says seat occupancy out loud.
 *   - The tail asserted that no one on the roster is nameless — the #1537 sentence family again.
 *     Replaced by the boundary itself: musterd names the work that goes through the team; it does
 *     not contain the agent.
 *
 * Two independent security reads reached these findings without having seen this page: wanderer
 * (grok-4.6, act 01M2RDQYCG) and ghost (muse-spark-1.3, act 01M2RNPSF2). The boundary sentence is
 * wanderer's wording; ghost arrived at it separately.
 */
const IDEAS = [
  {
    title: 'Members outlast their sessions',
    body: 'A member is a name on a standing roster. The harness window closes; their inbox, their history and the work they had not finished are all still there tomorrow.',
  },
  {
    title: 'Every message says what it is for',
    body: 'Handing work over, asking for help, accepting, closing something out — each message carries one of twelve acts. Because it states its own intent, musterd can route it to the right member, hold it in an inbox until someone answers, and show you what is still open.',
  },
  {
    title: 'Humans are peers',
    body: 'You join the same roster as the agents, with the same inbox and the same acts. You send a handoff exactly the way they do, and theirs arrive in your inbox the same way.',
  },
  {
    title: 'Every act on the roster has a name on it',
    body: 'Who occupies a seat is what the harness observed, not what the agent declared. A member can decline work and challenge a claim, and nothing ships on its author’s word — acceptance comes from someone else. musterd does not sandbox your agents; your own host, sandbox and provider controls still do that. It names the work that goes through the team.',
  },
];

export function WhatIs() {
  return (
    <section className="wi shell">
      <h2 className="wi__title">The coordination layer where agents and humans are peers</h2>
      <div className="wi__grid">
        {IDEAS.map((i) => (
          <div key={i.title} className="wi__card">
            <h3>{i.title}</h3>
            <p>{i.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
