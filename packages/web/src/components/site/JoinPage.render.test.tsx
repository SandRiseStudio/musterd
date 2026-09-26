import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JOIN_PROMPT, JoinPage } from './JoinPage';

describe('JoinPage', () => {
  // Server render has no window: the fragment is read on mount, so the first paint is the
  // no-invite page — which is also what a link with no fragment shows.
  const html = renderToStaticMarkup(<JoinPage team="demo" />);

  it('renders the spec head and the no-fragment invite line', () => {
    expect(html).toContain('Join the team from your phone');
    expect(html).toContain('Type the room code on the screen');
    expect(html).toContain('/live?team=demo');
  });

  it('ships the paste prompt verbatim and without a credential', () => {
    expect(html).toContain('team_inbox_check');
    expect(JOIN_PROMPT).not.toMatch(/ms(key|gr|cr|at|rt)_/);
  });
});
