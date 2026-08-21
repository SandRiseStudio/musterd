import { Footer } from '../Footer';

/**
 * The public-site footer. The existing landing Footer is already surface-generic (wordmark +
 * GitHub/SPEC/ROADMAP links), so this is an alias that gives content routes a site-scoped name —
 * if the footers ever diverge, they diverge here rather than in every route.
 */
export function SiteFooter() {
  return <Footer />;
}
