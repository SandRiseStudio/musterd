# 062 — The daemon serves the web UI same-origin

- Status: accepted
- Date: 2026-06-26

## Context

The live dashboard (`/live`, ADR 061) is a browser app that talks to the daemon over HTTP (`GET
/teams/:slug/messages`) and WebSocket (`subscribe team-all`). In development it runs on a Vite dev
server on a *different* port than the daemon, which is cross-origin — and cross-origin browser access
to the daemon hits two walls:

1. **No CORS** — the daemon never sets `Access-Control-Allow-Origin`, so a cross-origin `fetch` can't
   read the response.
2. **The WS Origin gate (ADR 040)** refuses any upgrade whose `Origin` isn't in `allowedOrigins` —
   the cross-site / DNS-rebinding defence.

The dev workaround is a Vite proxy that forwards `/teams` + `/ws` to the daemon and strips the Origin
so the gate sees a clean loopback client. That's fine for `pnpm dev`, but it's not a way to *ship* the
dashboard — production wants one process and one origin, not a separate static host plus a proxy.

## Decision

Let the daemon serve the built web UI itself, from one origin, so the dashboard and the API/WS share a
scheme+host+port — no CORS, no proxy.

1. **Static file serving.** A new config `webRoot` (`--web-root` flag / `MUSTERD_WEB_ROOT`, absolute,
   default null = off). When set, any unmatched `GET` *outside the API namespaces* (`/health`,
   `/teams/*`) is served from `webRoot`: a real file as-is, an extensionless client route (`/live`)
   falling back to `index.html` (deep-link + refresh work). Path traversal is refused by resolving
   under `webRoot` and requiring containment. API paths still 404 as JSON. Off by default, so existing
   API-only daemons and their tests are unchanged.

2. **Same-origin WS is allowed.** The Origin gate now admits an upgrade whose `Origin` host:port equals
   the `Host` header — i.e. a page the daemon itself served connecting back to it. This is the minimal,
   precise relaxation of ADR 040: it does *not* broaden to "any localhost origin", it allows exactly
   the same-origin case. A cross-site or DNS-rebinding `Origin` still differs from `Host` and is still
   refused; explicit `allowedOrigins` continue to work for deliberate cross-origin clients.

Packaging (which build of the web ships with which daemon, and a default `webRoot` baked into the
published CLI) is deferred — `webRoot` is explicit for now, which is all the dogfood/self-host path
needs. In dev the Vite proxy remains the inner-loop tool; static-serve is the deployment shape.

## Consequences

- `node bin.js serve --web-root packages/web/dist/client` serves the dashboard at
  `http://<host>:<port>/live` with the API and firehose on the same origin — no proxy, no CORS, and the
  browser's same-origin WS passes the gate. This is the real one-process deployment.
- The Origin relaxation is tight: same-origin only. It does not weaken ADR 040's cross-site defence
  (verified by test — `https://evil.example` against a loopback daemon is still rejected).
- Static serving is gated on `webRoot` being set, so it is zero-impact when unconfigured.
- A TLS daemon serves the UI over `https://` and same-origin `wss://` with no extra config — `scheme`
  already drives both.

## Observability & Evaluation

- **Traces:** n/a — static file responses are not part of the coordination envelope path and carry no
  trace context. The route log already covers the API/WS surface that matters; a static GET is a flat
  file read. If a need arises, request logging is the place, not a span.
- **Eval:** n/a — mechanical transport/hosting change, no agent-facing model decision to score.
- **Experiment:** n/a — no behavioural variant.
