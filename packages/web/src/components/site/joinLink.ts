/**
 * Pure helpers for `/join/<team>` (copy spec: docs/design/join-page-copy.md).
 *
 * The page is served from the daemon's own origin (ADR 452 §5), so the team's connector URL is
 * this origin plus `/mcp/<team>`. The fragment carries at most one of two values and neither ever
 * leaves the browser: `#i=<sel>.<secret>` is an ADR 450 invite, `#n=<nonce>` is an ADR 449 agent
 * connect code. Nothing here makes a request.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SELECTOR = /^[0-9A-Z]{3}$/;
const LINK_SECRET = /^[A-Za-z0-9_-]{27}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;

export type JoinFragment =
  | { kind: 'invite'; value: string; roomCode: string }
  | { kind: 'agent'; nonce: string }
  | { kind: 'none' };

/** Read `#i=` or `#n=` from a location hash. Anything malformed reads as no fragment. */
export function parseJoinFragment(hash: string): JoinFragment {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const invite = params.get('i');
  if (invite) {
    const roomCode = roomCodeFromInvite(invite);
    if (roomCode) return { kind: 'invite', value: invite, roomCode };
  }
  const nonce = params.get('n');
  if (nonce && NONCE.test(nonce)) return { kind: 'agent', nonce };
  return { kind: 'none' };
}

/**
 * The typed form of an invite, `SEL-XXXX-XXXX`: the selector, then the link secret's first 40 bits
 * in Crockford base32 — the same derivation the daemon uses at mint (`store/invites.ts`).
 */
export function roomCodeFromInvite(value: string): string | null {
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const selector = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (!SELECTOR.test(selector) || !LINK_SECRET.test(secret)) return null;
  const bytes = base64urlToBytes(secret);
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < 8) {
      out += CROCKFORD[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 8) break;
  }
  return `${selector}-${out.slice(0, 4)}-${out.slice(4)}`;
}

/** The team's connector URL — the same for everyone, and never carrying a secret. */
export function connectorUrl(origin: string, team: string): string {
  return `${origin}/mcp/${encodeURIComponent(team)}`;
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
