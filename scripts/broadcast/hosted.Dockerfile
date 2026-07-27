# The hosted broadcast capture box (hosting spec, Increment 1).
#
# One image, one job: join the tailnet, load /broadcast from the Air's daemon, stream to Twitch at
# the measured passing configuration (720p25 · libx264 · performance-4x — spec amendment
# 2026-07-27). The machine's lifetime is the stream's lifetime: the entrypoint execs
# `musterd broadcast`, and when the stream ends the process exits and the machine stops.
#
#   scripts/broadcast/live.sh build     # build + push this image once (or after a code change)
#   scripts/broadcast/live.sh start     # go live
#
# Build context is the repo root. Differences from the bench image (broadcast-bench.Dockerfile):
# tailscale is here, the fixture toolchain is not, and the entrypoint streams instead of idling.
FROM node:22-bookworm-slim

# chromium + ffmpeg are the pipeline; fonts stop the office rendering tofu; tailscale is the
# reachability layer (ADR 039 topology B). python3/make/g++ exist only for better-sqlite3's
# node-gyp build during pnpm install.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      ca-certificates \
      curl \
      procps \
      fonts-dejavu-core \
      fonts-liberation \
      python3 \
      make \
      g++ \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
       > /usr/share/keyrings/tailscale-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/debian bookworm main" \
       > /etc/apt/sources.list.d/tailscale.list \
  && apt-get update && apt-get install -y --no-install-recommends tailscale \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app
COPY . .

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @musterd/cli... --filter '!@musterd/web' build

ENTRYPOINT ["bash", "/app/scripts/broadcast/entrypoint.sh"]
