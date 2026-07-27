# Increment 0 run C/D — the broadcast capture pipeline on a rented Linux box.
#
# This image exists to answer two questions the laptop cannot (see
# docs/superpowers/specs/2026-07-26-broadcast-hosting-design.md):
#   1. what `libx264` costs, since darwin never pays for its own encode; and
#   2. whether the box composites near 60Hz, which `screencastEveryNthFrame` assumes.
#
# It is a measurement rig, not the Increment 1 production image: it carries the whole toolchain and
# builds from source so the numbers come from the commit under test, and its entrypoint idles so a
# human can `fly ssh console` in and drive runs by hand.
#
#   fly deploy --dockerfile scripts/perf/broadcast-bench.Dockerfile --remote-only
#
# Build context is the repo root.
FROM node:22-bookworm-slim

# chromium + ffmpeg are the pipeline. fonts matter more than they look: the office scene draws seat
# names and the overlay to canvas, and a fontless box silently renders tofu into the benchmark.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      sqlite3 \
      ca-certificates \
      curl \
      procps \
      fonts-dejavu-core \
      fonts-liberation \
      python3 \
      make \
      g++ \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app
COPY . .

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm build

# Idle. Every run is driven interactively over `fly ssh console`, because deciding what to measure
# next depends on what the last run said.
CMD ["sleep", "infinity"]
