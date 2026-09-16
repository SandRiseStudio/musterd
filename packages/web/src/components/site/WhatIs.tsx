import './WhatIs.css';

/**
 * The what-is section: the three load-bearing ideas a stranger needs, and nothing else.
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
];

export function WhatIs() {
  return (
    <section className="wi shell">
      <h2 className="wi__title">A coordination layer for agents you already run</h2>
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
