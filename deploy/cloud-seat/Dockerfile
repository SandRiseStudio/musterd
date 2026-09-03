# The cloud seat image (cloud-seats design, increment 1 — rescoped 2026-09-03 for federation).
#
# One image, one job: be the SECOND MACHINE of a musterd team. It runs its own daemon (ADR 325: a
# machine daemon, a replica), enrolls at the laptop hub over the tailnet (ADR 328 / 376), and runs
# the wake actuator so a seat that lives here can be woken (ADR 131). The daemon's SQLite, the
# tailscale state and the seat workspace all live on the /data volume, so the machine's identity
# (ADR 331: the node id is the joiner's) survives a redeploy.
#
#   fly deploy --config deploy/cloud-seat/fly.toml --app musterd-seat-<name>   # build + start
#
# Build context is the repo root (the CLI is built from THIS checkout, so the seat runs the build
# you deployed — the ADR 260 pin, by construction). Differences from the broadcast image
# (scripts/broadcast/hosted.Dockerfile): no chromium/ffmpeg/pulseaudio; git + gh + the claude CLI
# instead, because a seat works on branches and is woken as `claude -p`.
FROM node:22-bookworm-slim

# python3/make/g++ exist only for better-sqlite3's node-gyp build during pnpm install. tailscale is
# the reachability layer (ADR 039 topology B — the hub is loopback-bound on the laptop and the
# tailnet is how this machine reaches it). git + gh + openssh are what a seat needs to do work.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      openssh-client \
      procps \
      python3 \
      make \
      g++ \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
       > /usr/share/keyrings/tailscale-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/debian bookworm main" \
       > /etc/apt/sources.list.d/tailscale.list \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       > /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends tailscale gh \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:/app/node_modules/.bin:$PATH

# The harness the wake actuator spawns (claudeCode backend: `claude -p …`, reply-only, default
# permission mode). Pinned by the build arg so a redeploy is a deliberate upgrade.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

WORKDIR /app
COPY . .

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @musterd/cli... --filter '!@musterd/web' build \
  && ln -s /app/packages/cli/dist/bin.js /usr/local/bin/musterd \
  && chmod +x /app/packages/cli/dist/bin.js

# Everything that must outlive the container lives under /data (the Fly volume): HOME is moved
# there so ~/.musterd (config, SQLite, node.json, bindings) and ~/musterd/<team> (the team home)
# land on the volume without any product-code path override.
ENV HOME=/data/home
ENV MUSTERD_DB=/data/home/.musterd/musterd.db

ENTRYPOINT ["bash", "/app/deploy/cloud-seat/entrypoint.sh"]
