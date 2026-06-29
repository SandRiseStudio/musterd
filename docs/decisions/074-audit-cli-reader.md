# 074 — `musterd audit` CLI reader

- Status: accepted — 2026-06-29
- Date: 2026-06-29

## Context

ADR 071 (v0.3 P2) landed the governance audit log — an append-only `audit` table written by every
governed decision (`urgent.flagged/denied`, `send.denied`, `member.reclaim/remove`, `observe.denied`)
and exposed via an **admin-only** `GET /teams/:slug/audit` (`?limit`, `?before`, newest-first). The
server-side type lives in `@musterd/server`'s `store/audit.ts` (`AuditAction` union + `AuditRow`); the
wire response shape is `{ audit: [{ id, ts, actor, action, target, result, detail }] }` with `detail`
parsed back to an object. Until now the only way to read it was a raw `curl`/fetch — there is no CLI
surface, and June's governance web surface (the roster rail + audit view) is still in flight in
`packages/web`. Jasmine explicitly offered the endpoint as a pairing slice for a CLI reader.

## Problem

The audit log is the coordination-governance trace the batond flywheel (ADR 051) consumes and the
artifact an admin reaches for to answer "who did what, and was it allowed?". With no CLI reader, an
agent or human admin can't read it from the surface they already use — they'd have to construct an
authenticated `GET` by hand. The reader must (per the handoff that scoped it):

- mirror the server contract exactly (`--limit` 1..500, `--before <ms-epoch>` paging, `--json`
  passthrough, newest-first),
- treat `action` as an **OPEN string** so P3's new verbs (`grant.*`, `claim.*`,
  `account_status.change`, …) render plainly instead of erroring — no CLI release required,
- stay disjoint from the web lane (June/Cleo) and the server lane (Jasmine): touch only
  `packages/cli` (+ its client), and
- honour the boundary rule (conventions: parse external input through a zod schema at the boundary)
  without forcing a protocol change that lacks a decision.

The open question is where the wire schema lives. `@musterd/protocol` is the only package imported
across boundaries and the natural home for a shared wire contract, but the hard rule ("never change
`@musterd/protocol` schemas without an ADR") protects it — and ADR 071 deliberately kept the audit
type server-side because the verb set is still growing.

## Decision

1. **Add an open-string audit schema to `@musterd/protocol`** (`src/audit.ts`, exported from
   `index.ts`): `AuditEntrySchema` (`action: z.string()`, not enumerated) + `AuditResponseSchema`.
   This is the read-side wire contract; the server's `AuditAction` union stays the enumerated
   write-side type. `action` is an open string so P3 adds rows, not schema — no protocol bump per
   verb. This is a protocol-schema change, gated by this ADR (satisfying the hard rule).

2. **`musterd audit` command** (`packages/cli/src/commands/audit.ts`) wired into `bin.ts` dispatch
   + help. Admin-only, so it resolves via `resolve()` (the **act** path, ADR 036) — an explicit
   identity is required; an ambient global-config read can't list who-did-what. Flags: `--limit`
   (integer 1..500, else exit 2), `--before <ms-epoch>` (positive integer, else exit 2), `--json`.
   Pretty-prints `<HH:MM> <actor> [<action>] <allow|deny> → <target> <detail>` (allow green / deny
   red), with a roster read for the actor→kind lookup (like `inbox`). The oldest row's ts is printed
   as the next `--before` cursor. `--json` passes the raw `AuditEntry[]` through.

3. **`HttpClient.audit`** (`packages/cli/src/client.ts`) does the `GET` and parses the response
   through `AuditResponseSchema.safeParse` at the boundary — a malformed body throws rather than
   reaching the renderer. This is the one place the CLI validates an audit response; it honours the
   boundary rule without changing how existing client methods behave.

4. **No server change, no web change.** The server already serializes the documented shape; the
   schema is additive and permissive, so the server need not import it (it can later). Stays out of
   `packages/web` (June/Cleo) and `packages/server` (Jasmine) per the lane guardrails.

## Consequences

- An admin can read the governance audit log from the CLI: `musterd audit`, `musterd audit --limit
  50`, `musterd audit --before <ts>`, `musterd audit --json`. The web audit view (June's lane) and
  this CLI reader share one protocol schema, so they can't drift on the contract.
- The audit wire schema is now in `@musterd/protocol` (read-side, open-string `action`). P3 adds
  verbs by writing new `action` strings — the schema and the CLI both accept them unchanged. If P3
  ever wants an enumerated read-side union (e.g. for typed rendering), that's a new ADR superseding
  the open-string decision here.
- A non-admin token gets `forbidden` (exit 5) from the server, surfaced through the standard
  `CliError` → exit-code mapping; the CLI adds no auth logic of its own.
- Builds on ADR 071 (the audit log + endpoint), ADR 036 (act vs read identity resolution), ADR 052
  (this is an agent-facing surface — observability below).

## Observability & Evaluation

**Traces** — the command is a read; it emits no coordination acts of its own. It surfaces the
existing audit trace (ADR 071's `appendAudit` rows) to an admin. An admin running `musterd audit`
is itself a governed-ish signal but is intentionally **not** audited (auditing the read of the audit
log would recurse and chill the very transparency ADR 071 wants); `GET /audit` is admin-only but
read-only and unlogged.

**Eval** — success = "the CLI reader matches the server contract and stays forward-compatible".
The paired allow/deny + paging tests are the regression guard: a `member.reclaim` row renders with
`action`/`target`/`result`; `--limit` caps; `--before <ts>` pages to the older row; `--json` round-
trips the `AuditEntry` shape; an unknown `action` (`grant.role`) parses through `AuditResponseSchema`
without rejection (the P3 forward-compat guard); a non-admin token is refused with exit 5. Baseline:
the server integration test's `GET /audit is admin-only` assertion (the wire contract this mirrors).

**Experiment** — none yet. A future one: does CLI access to the audit log (vs only the web view)
change how often an admin reviews governed decisions, and does the open-string rendering keep an
upgraded-P3 CLI useful against an older server (and vice versa)? The audit log itself is the
measurement substrate.
