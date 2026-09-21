import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import brandCss from '../brand/brand.css?url';
import chipIcon from '../brand/chip.svg?url';
import socialCard from '../brand/social-card.png?url';
import {
  SITE_CARD_ALT,
  SITE_SHARE_DESCRIPTION,
  SITE_ORIGIN,
  SITE_TAGLINE,
  SITE_TITLE,
  absoluteUrl,
} from '../brand/siteMeta';
import globalCss from '../styles/global.css?url';

const ogImage = absoluteUrl(socialCard);

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'light' },
      { name: 'theme-color', content: '#f7efe2' },
      { title: SITE_TITLE },
      { name: 'description', content: SITE_TAGLINE },
      { property: 'og:title', content: SITE_TITLE },
      { property: 'og:description', content: SITE_SHARE_DESCRIPTION },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: SITE_ORIGIN },
      { property: 'og:site_name', content: SITE_TITLE },
      { property: 'og:locale', content: 'en_US' },
      { property: 'og:image', content: ogImage },
      { property: 'og:image:alt', content: SITE_CARD_ALT },
      // Stated so a client can reserve the card's box before the image arrives; Slack and
      // LinkedIn both render a narrow placeholder without them.
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:image', content: ogImage },
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
    /* Light is PINNED, deliberately — ADR 431. Not a default waiting for a
       prefers-color-scheme path: the hero's office still is a photograph of a daylight room, so a
       dark page around it is the two-rooms-in-one-viewport composition ADR 428 removed from that
       section. The dusk tokens are healthy (measured: 2 AA rows on `/`, zero elsewhere) and stay
       live on /live via `.lc`. ADR 431 names the three things that would reopen this. */
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
