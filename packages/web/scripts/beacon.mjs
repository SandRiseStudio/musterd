/**
 * Cloudflare Web Analytics for musterd.io, injected at STAGE time (ADR 302's allowlist step).
 *
 * Why here and not in `__root.tsx`: that shell is shared by every route, so a head entry would put
 * a third-party script on /live, /board, /audit, /approvals and /broadcast too — daemon-connected
 * surfaces (ADR 132) that the daemon serves from `dist/client`, and which ADR 156 keeps out of
 * packaged installs. Injecting into `dist/site` instead means the beacon exists in exactly the
 * artifact wrangler deploys and nowhere else, which is the same safety property the allowlist has.
 *
 * Why injected at all: the zone's Web Analytics ruleset is `auto_install`, and auto-install works by
 * rewriting HTML at the edge — which does not happen for an assets-only Worker response. The
 * ruleset has been enabled and unreached since the site became a Worker (2026-08-21, 6aaff801);
 * RUM's last pageload is 2026-08-26 while the zone kept serving 400–2,400 requests a day.
 *
 * The token is a public beacon token: it identifies the site to Cloudflare and is designed to be
 * read by every visitor. It is not a credential and grants nothing.
 */
export const BEACON_TOKEN = '37759ad50a0f4801800cb55a5dd2d591';

/** The exact snippet Cloudflare serves for this site tag. */
export function beaconTag(token = BEACON_TOKEN) {
  return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${token}"}'></script>`;
}

/** True once the document already carries a beacon, so staging twice is not two beacons. */
export function hasBeacon(html) {
  return html.includes('static.cloudflareinsights.com');
}

/**
 * Put the beacon last in <head>. Returns the unchanged string when one is already there, and null
 * when there is no </head> to inject into — the caller fails loudly rather than deploying a page
 * that silently records nothing, which is the failure this whole module exists to end.
 */
export function injectBeacon(html, token = BEACON_TOKEN) {
  if (hasBeacon(html)) return html;
  const at = html.lastIndexOf('</head>');
  if (at === -1) return null;
  return `${html.slice(0, at)}${beaconTag(token)}${html.slice(at)}`;
}
