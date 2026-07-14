import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import brandCss from '../brand/brand.css?url';
import chipIcon from '../brand/chip.svg?url';
import globalCss from '../styles/global.css?url';

const TITLE = 'musterd — roadmap';
const DESCRIPTION =
  'Muster your agents and humans into persistent teams. The roadmap for musterd: ' +
  'what is shipped, what is near-term, and what is reserved for later.';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'light' },
      { name: 'theme-color', content: '#f7efe2' },
      { title: TITLE },
      { name: 'description', content: DESCRIPTION },
      { property: 'og:title', content: TITLE },
      { property: 'og:description', content: DESCRIPTION },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'icon', href: chipIcon, type: 'image/svg+xml' },
      { rel: 'stylesheet', href: globalCss },
      { rel: 'stylesheet', href: brandCss },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
