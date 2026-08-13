# Probing with a temp daemon

Run probes against a throwaway daemon on its own DB and port — never against the shared daemon on :4849, and never via `musterd team create` from an unguarded shell.

## The recipe (verified 2026-08-12; falsify: run it)

Point `MUSTERD_DB`, `MUSTERD_CONFIG`, `MUSTERD_HOST_REGISTRY` at a scratch dir, then `node packages/cli/dist/bin.js serve --port 4877`. Seed CLI identities under config key `knownIdentities` (NOT `vault`) as `[{team,name,key,surface}]`. Kill by PID when done — `pkill -f "bin.js serve"` kills the operator's shared daemon too.

## Probe extras (2026-08-12, the ADR 241 live-observation run; falsify: rerun the recipe)

- The interloper gate (#744) fires on a probe RE-RUN: a still-un-ended live-looking slot gates the newcomer, which then attests nothing — delete `binding.session` between runs.
- A wake-provenance probe needs no `musterd agent` at all (so no `~/.claude.json` clobber): hand-write `binding.json` + a project `.claude/settings.json` with the capture hook, shim `musterd` on PATH, then `MUSTERD_PROVENANCE=wake MUSTERD_WAKE_LEASE=<real lease> claude -p …`.
- `musterd send` on the probe needs `--urgent --urgent-reason`; wake metrics do not render in `report coordination` — read the `GET /teams/:slug/report` JSON.

## The repoint trap (2026-08-12; falsify: read team.ts)

~~`musterd team create` writes `server` + `current` into the machine-global `~/.musterd/config.json`, silently repointing every CLI on the box~~ FIXED 2026-08-12 by #780 — the machine default is now claimed only with `--switch` or when no `current` exists, and both branches print. The failure shape is still worth knowing: the damage presented as infrastructure being down (an hour lost 2026-08-12), and folders WITH a binding were immune, which is why the creating session never noticed.
