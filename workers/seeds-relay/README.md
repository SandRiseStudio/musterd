# musterd seeds relay

Always-on Cloudflare Worker for musterd seeds (ADR 248). Captures raw ideas from SMS and
Slack, buffers them verbatim in KV, and serves them to the daemon over an authenticated pull
endpoint. It never interprets a seed — capture and cleanup are deliberately separated, and the
buffer here is the source of record.

Lives outside the pnpm workspace on purpose: it deploys with wrangler, shares no code with the
daemon, and must not add dependencies to the monorepo install (the daemon's autorefresh does
not `pnpm install`).

## Deployed

`https://musterd-seeds-relay.nick-sanders-a.workers.dev` (Cloudflare account
`0f159d2f0622a4fef8e07d64d4a9bdb0`, KV namespace `58c05cfa4ea94dc5a1cf22476f98e665`).

Every route fails closed until its secret exists: a missing `PULL_TOKEN`/`TWILIO_AUTH_TOKEN`/
`SLACK_SIGNING_SECRET` is a 500, not an open door. Deploying before the secrets are set is
therefore safe — the Worker is inert until configured.

## Deploy

```bash
cd workers/seeds-relay
npm install
npx wrangler kv namespace create SEEDS_KV   # paste the id into wrangler.toml
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_WEBHOOK_URL
npx wrangler secret put PULL_TOKEN          # any long random string; the daemon presents it
npm run deploy
```

Then:

- **Twilio**: point the number's inbound-SMS webhook at `https://<worker>/ingest/twilio`
  (HTTP POST). Replies are an empty TwiML ack — no outbound SMS is ever sent.
- **Slack**: create/reuse an app with Event Subscriptions → request URL
  `https://<worker>/ingest/slack`, subscribe to `message.channels`, invite the app to the
  dedicated seeds channel, and optionally pin `SLACK_SEEDS_CHANNEL` in wrangler.toml to that
  channel's id. Confirmation ("🌱 saved") posts through `SLACK_WEBHOOK_URL`.
- **musterd**: set the team policy keys `seeds_relay_url` and `seeds_relay_token`; the daemon
  polls `GET /seeds?after=<cursor>` and opens a lane per seed.

## Endpoints

| Route                 | Auth                               | Behaviour                                      |
| --------------------- | ---------------------------------- | ---------------------------------------------- |
| `POST /ingest/twilio` | Twilio HMAC-SHA1 signature         | buffer `Body` as a seed, empty TwiML ack       |
| `POST /ingest/slack`  | Slack v0 signing + 5m window       | handshake, buffer fresh human channel messages |
| `GET /seeds?after=id` | `Authorization: Bearer PULL_TOKEN` | seeds with id > `after`, oldest first, ≤100    |

Seeds are never deleted or mutated by pull; the daemon keeps its own cursor.
