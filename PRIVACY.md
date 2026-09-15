# Privacy

musterd does not phone home.

The product is a local daemon and a SQLite file on the machine that runs it. There is no musterd account, no musterd cloud, and no usage analytics **in the product**. Installing the CLI does not open a connection to us. The public website is a separate surface and is measured — see [The website counts visits](#the-website-counts-visits).

## Telemetry is off until you point it

OpenTelemetry is built in and **off by default**. The SDK starts only when you set a standard OTLP env var (`OTEL_EXPORTER_OTLP_ENDPOINT`, or the traces/metrics variants) and never when `OTEL_SDK_DISABLED=true`. `musterd service install` does not write an endpoint unless you pass `--otlp-endpoint`.

When it is on, spans and metrics go **only** to the endpoint you configured. There is no musterd-operated collector in the product path. Message **bodies are never telemetry** — not Act text, not tool-arg bodies, not secrets. Identity on a span is a Team, a Member id, and an Act name.

If product-usage analytics are ever wanted, that is a separate, explicit, opt-in decision with its own ADR — and this file changes in the same commit. Visits to the website are not product-usage analytics and are covered below; nothing the daemon does is measured by them.

## The website counts visits

**musterd.io runs Cloudflare Web Analytics.** It is cookieless and stores nothing on your device: no cookie, no `localStorage`, no identifier that follows you between visits or to any other site. What Cloudflare records for us is a page load — the URL, the referring site, a country, a device class, and a timing — aggregated. We get counts, not people. We build no picture of an individual reader: one visit is never joined to another, and there is no way for us to look a reader up.

It is on the website only. The pages the daemon serves — `/live`, `/board`, `/audit`, `/approvals`, `/broadcast` — carry no third-party script at all, because the beacon is added when the public site is staged for deploy and never enters the bundle the daemon ships ([ADR 132](./docs/decisions/132-live-viewer-on-daemon-origin.md), [ADR 302](./docs/decisions/302-musterd-io-public-site.md)). Your own daemon does not report your use of it to anyone, which is the promise at the top of this file and is unchanged.

Why we measure it at all: we write the site for strangers, and without counts we cannot tell whether anything we publish is read. That is a question about our own pages, and we answer it with the least data that answers it.

## What stays on your machine

Team state (roster, Presence, Inbox, Lanes, Acts) lives in local SQLite. Config, credentials (`mskey_` / `msgr_` / `mscr_`), and logs live under `~/.musterd` with credentials chmod-600. Nothing in that tree is uploaded by the product.

## Optional rails you deploy

A Team may opt into a **seeds relay**: a Cloudflare Worker *you* deploy, with seeds landing in *your* KV, pulled by *your* daemon. That is capture you chose, not a musterd backend. Slack or Twilio see what you send them on those channels. The `*.workers.dev` URL in `workers/seeds-relay/` is Sandrise dogfood, not a product default.

`service refresh` updates the daemon from the git checkout you already pointed it at. That is your origin, not ours.

Package registries (npm, Homebrew) see a download when you install. That is those registries, not musterd telemetry.

## Dogfood is not the product default

The daemons **we** operate may export OTLP to a collector on localhost so our own sessions are measurable. That is [ADR 082](./docs/decisions/082-instrument-by-default-telemetry.md), scoped to dogfood, documented in [`docs/dogfood-telemetry.md`](./docs/dogfood-telemetry.md). The product default stays off.

## Research artifacts

A coordination-traces dataset may be published later. v1 is structural-only ([ADR 184](./docs/decisions/184-dataset-consent-and-redaction.md)): no Act prose, no seat names in the release files. An export is not a publication; a HuggingFace upload needs a fresh human authorization per release. Writing a dataset card grants nothing.

## Spec

[ADR 015](./docs/decisions/015-otel-layer1-server.md) · [ADR 082](./docs/decisions/082-instrument-by-default-telemetry.md) · [ADR 089](./docs/decisions/089-telemetry-l2-client-sdk.md) · [`docs/design/observability.md`](./docs/design/observability.md) §config
