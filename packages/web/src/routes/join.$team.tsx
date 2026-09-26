import { createFileRoute } from '@tanstack/react-router';
import { JoinPage } from '../components/site/JoinPage';

/**
 * `/join/<team>` — the page a person opens to join a team (copy spec:
 * docs/design/join-page-copy.md). Served from the daemon's own origin, like /live (ADR 132,
 * ADR 452 §5), never prerendered: the connector URL is this origin, and the fragment it reads
 * (`#i=` invite, `#n=` agent connect code) never leaves the browser.
 */
export const Route = createFileRoute('/join/$team')({
  head: () => ({
    meta: [
      { title: 'Join the team — musterd' },
      {
        name: 'description',
        content: "Add one connector, sign in, and you're on a live musterd team from your phone. No install.",
      },
      { property: 'og:title', content: 'Join the team from your phone' },
      {
        property: 'og:description',
        content: "Add one connector, sign in, and you're on a live musterd team from your phone. No install.",
      },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: Join,
});

function Join() {
  const { team } = Route.useParams();
  return <JoinPage team={team} />;
}
