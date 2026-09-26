# The demo-audience load bench (lane 01M3D4069F) — a throwaway Linux box for
# scripts/perf/demo-audience-load.mjs, because the load it generates saturates a laptop on its own.
#
# A measurement rig, not a deployable daemon: it builds musterd from the commit under test and idles
# so a human (or a seat) can `fly ssh console` in and drive runs. No browser, no ffmpeg — only what
# the server and the harness need. `util-linux` carries taskset, which pins the daemon to its cores.
# `cloudflared` carries the tunnel leg: the daemon's REMOTE_URL runs go loopback → cloudflared →
# the Cloudflare edge → back, the demo's real human path (docs/operations/public-demo-tunnel.md).
#
#   fly deploy -c scripts/perf/loadbench.fly.toml --remote-only
#
# Build context is the repo root.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      procps \
      util-linux \
      python3 \
      make \
      g++ \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL \
       https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
       -o /usr/local/bin/cloudflared \
  && chmod +x /usr/local/bin/cloudflared

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app
COPY . .

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter "@musterd/server..." build

CMD ["sleep", "infinity"]
