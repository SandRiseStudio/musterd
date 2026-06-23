import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultNotFoundComponent: () => (
      <main className="shell" style={{ padding: '20vh 0' }}>
        <h1 className="mono">404</h1>
        <p>
          Nothing here. <a href="/">Back to the roadmap.</a>
        </p>
      </main>
    ),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
