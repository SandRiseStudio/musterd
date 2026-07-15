# musterd's MCP server, examined — names, descriptions, schemas, results & discovery

> Status: **captured idea / seed brief** — not yet an ADR, not yet designed. Written 2026-07-14 (stanley)
> from a batch of external sources plus a read of our own MCP package. This is the internal home for the
> `mcp-tool-surface` roadmap item; it exists to hold the evidence and name the increments, not to freeze
> a decision.

## The frame

musterd's MCP adapter is the whole surface agents actually read — not just what an agent **sends** (the
`team_*` / `lane_*` tool names, descriptions, and schemas) but what it **reads back** (every tool
result, empty states included). That surface is a **designed product artifact**, and it has grown
without a deliberate design pass. This brief is about examining it as such: are the tools named
consistently, described concisely, shaped cleanly, and discoverable — and does every result come back
informative, intuitive, and action-naming for an agent, even when there is nothing to report — or is a
connecting agent handed a wall of schema on every call and a bare "no members" when it asks? The rest
of the ecosystem is scrutinizing the input half right now, which makes it a good moment to hold all of
ours up to the same light.

This is **not** primarily a telemetry item. Measuring what the surface costs is a useful supporting
input (see the last section), but the work is the craft of the server itself.

## Our surface today (read 2026-07-14)

The MCP package (`packages/mcp/src/tools/`) registers **18 tools**:

- `team_join`, `team_leave`, `team_status`, `team_members`, `team_inbox_check`, `team_send`,
  `team_next`, `team_goals`, `team_goal_declare`, `team_report`, `team_memory_save`,
  `team_memory_read`
- `lane_open`, `lane_claim`, `lane_update`, `lane_handoff`, `lane_resolve`, `lane_board`

Three concrete pieces of craft debt stand out on a first read:

- **Namespace drift.** Twelve tools share the `team_` prefix; the six lane tools sit outside it as
  `lane_*`. An agent scanning the roster sees two conventions for one server. Either the lanes are
  `team_lane_*`, or the split is deliberate and worth stating — right now it just reads as drift.
- **Heavy prose descriptions.** Rough description-region weights: `lanes.ts` ~2.9K chars, `send.ts`
  ~1.7K, `insights.ts` ~1.3K, `memory.ts` ~0.9K. `team_send`'s description alone is a ~250-word
  paragraph that enumerates nine acts (status_update, request_help, handoff, accept/decline, wait,
  resolve, steer, challenge, defer) with their ADR references inline. Every one of those bytes ships on
  every call that loads the tool. The Reddit field note below argues descriptions are the single
  biggest lever here.
- **No discovery affordance.** The full schema of all 18 tools loads on every call, regardless of the
  seat's role or whether the turn needs any of them. A read-only observer seat loads the acting tools
  (`team_send`, `lane_*`) it can never meaningfully use.
- **Uneven result / empty-state helpfulness.** The output half is already taken seriously in places:
  `format.ts` is explicitly "rendered for an agent to read" (ANSI is noise, silence for absent facets),
  and several empty states name the next action — `lane_board` returns "no lanes — `lane_open` to
  declare your work", `team_next` "nothing in flight — `lane_open` {title, claim:true} to declare your
  work". But it is not a held standard: `team_members` / `team_status` return a bare "no members", and
  there is no audit that every tool's result — success, empty, and error — is informative and
  action-naming. An agent's **next move** is decided from the result it reads, so a terse empty state
  is a dropped hint.

## The evidence (external, July 2026)

- **Reddit r/ai_agents, "burning 20K+ tokens on a single 'hi'."** The lived version, and the most
  on-point: one MCP server shipped ~20K tokens of tool schema before the message. Top reply — **"tool
  descriptions are the biggest culprit, not the parameter structure"** — a cheap router call to
  classify intent with no schemas, then inject only matching tools; and strip descriptions on
  low-complexity turns. Other fixes: a thin proxy exposing one tool instead of eight, disabling unused
  toolsets, prompt-caching a stable tool prefix at 0.1×.
- **"The complete guide to tool selection in AI agents" (ML Mastery).** Accuracy degrades once a
  catalog passes ~15–20 tools (we are at 18). A stacking strategy: **gating** (a "hi" needs zero
  schemas), **retrieval** (top-K tools per query), **semantic routing** (to tool categories),
  **planner-scoping** (tools per step). Cites accuracy 13.62%→43.13% and >50% fewer prompt tokens from
  retrieval filtering. Directly relevant to naming, describing, and grouping our tools.
- **Alibaba, "SkillWeaver."** On-demand tool discovery — decompose → retrieve → compose over a
  **2,209-tool** library — cut per-query context from ~884,000 tokens to ~1,160 (>99%) while raising
  decomposition accuracy 51%→92%. The pattern for a `get_more_tools`-style discovery affordance if our
  catalog keeps growing.
- **OpenAI GPT-5.6 programmatic tool calling.** Model-written code calls tools instead of emitting a
  tool-call per step; named-customer token cuts of 38–63.5%. A reminder that "one schema-driven call
  per turn" is not the only invocation model — dug into mechanically in the adjacent-systems sweep
  below.
- **The New Stack, "The MCP debate has a context problem."** Scoping the surface is structural least
  privilege: "when an agent's MCP connection only exposes the tools required for its specific task, the
  agent cannot exceed that scope." The argument for rendering tools per role rather than all-to-all.
- **modelcontextprotocol.io, "Enterprise-managed authorization."** How a governed MCP surface is
  administered at scale (IdP-centralized, role/group-scoped server access) — the direction if scoping
  the surface later extends to the external servers a team reaches.

## Adjacent systems, checked for borrow/validate/rethink (2026-07-15)

A second sweep at nick's prompting — does anything here change the shape above, and what is worth
borrowing?

- **Anthropic advanced tool use (Tool Search Tool, `defer_loading`, `input_examples`).** The strongest
  validation of increment 5 — and it lives in the _harness_, not the server: tools marked
  `defer_loading: true` stay out of context until a search tool pulls them in as `tool_reference`
  blocks. Measured: 50+ MCP tools drop from ~72K to ~8.7K tokens, and **accuracy rises** (Opus 4.5
  79.5%→88.1% on MCP evals) — the deeper win is selection quality, not just bytes. Two consequences for
  us: (a) our discovery increment may be partly _free_ on harnesses that adopt Tool Search — our job is
  then to write names + descriptions that retrieve well (increments 1–2 become the enabler); (b)
  `input_examples` (72%→90% on complex parameter handling) is a concrete, borrowable lever for
  `team_send`'s nine-act problem — worked examples per act instead of a longer paragraph.
- **GPT-5.6 programmatic tool calling, mechanically (openai.com + the API guide).** Tools opted in via
  `allowed_callers: ["programmatic"]` become async functions in a `tools.*` namespace inside
  model-written JavaScript, run in OpenAI's isolated V8 runtime (the app never executes the generated
  code; loops/aggregation happen in-runtime, only final results return). Two things matter for us as a
  server author. First, **`output_schema` is first-class**: the model writes code against the tool's
  typed _return_ shape, so the guidance to authors is structured, compact returns; exact, documented
  error behavior; idempotent calls; specific names/descriptions. That creates a real tension with our
  prose-rendered results (`format.ts` deliberately returns agent-readable text): a programmatic caller
  wants JSON it can `.filter()`, a conversational caller wants prose that names the next action. The
  results increment should decide this deliberately — likely structured-first with the prose hint as a
  field, or a documented return format per tool — rather than let one shape win by default. Second, the
  boundary OpenAI draws: programmatic for bounded, predictable control flow; classic calls for
  adaptive/semantic/approval-sensitive steps — musterd's acts are mostly the latter (a `handoff` wants
  fresh judgment, not a loop), so our surface is not the one programmatic calling revolutionizes, but
  batch reads (`team_members` over a big roster, `lane_board` filtering) fit it. Note it does _not_ cut
  schema tokens — schemas still load upfront; it cuts round-trips and intermediate-result tokens.
  Nick's field observation using the 5.6 family: noticeably better at _actually using_ tools and
  picking the right one for the use case — consistent with the accuracy-not-just-tokens pattern in the
  Anthropic Tool Search numbers, and more weight behind writing tools whose names/descriptions/return
  contracts compose well, because the models are increasingly good enough to exploit exactly that.
- **MCP spec issue #2808 (tool schema token overhead).** The problem is now an open spec concern with
  production data (~1,000 tokens/tool; 20–30 tools = 10–15K before the first message). Its three
  proposals map onto ours: discovery-tier vs invocation-tier schemas (our increment 5), schema
  versioning for cache stability, and **tool namespacing** — which directly validates treating our
  `team_*`/`lane_*` drift as a real defect, not cosmetics.
- **MCP tool caching.** Partially answers our open question: harness prompt caching does blunt the
  _cost_ of a stable tool prefix (cached input at ~0.1×), but it does nothing for _selection accuracy_
  or context-window occupancy — and any server whose tool list mutates (our per-seat render under
  scope-by-role!) invalidates the prefix. Design consequence: **the rendered surface per seat should be
  stable within a session** — scope by role at render-time (stable, cacheable), don't mutate the tool
  list mid-session (cache-hostile). Schema versioning (#2808) is the complementary server-side move.
- **Scalekit AgentKit.** A credential/token broker between agents and third-party apps (connections,
  connected accounts, per-tool authenticated proxying, "virtual MCP servers"). Not a fit for the
  surface item itself, but it is the productized form of the _outward_ governance direction (which
  external tools may this agent reach, brokered and audited) — a landscape.md candidate next to the
  enterprise-managed-auth spec work, and a reference design if scoping ever extends beyond our own
  server.
- **Open Policy Agent (OPA/Rego).** The pattern worth borrowing is the **decoupling**: policy decision
  (which tools does this seat get?) separated from enforcement (the adapter render), with the decision
  producing structured output from structured input. We should _not_ take the dependency — musterd's
  ethos is a small core and structurally-enforced scope, and a general policy engine is the allowlist
  problem in fancier clothes unless the output feeds a structural render. But expressing role→tool
  scoping as declarative data the render consumes (rather than code baked per role) is the right
  internal shape, and keeps the door open to richer policy later.
- **RocketRide.** An AI-pipeline runtime that can expose a whole pipeline as **one MCP tool**. The
  relevant idea is granularity: a coarse tool wrapping a multi-step workflow is sometimes the right
  surface (the Reddit thread's thin-proxy fix is the same move). For us the analogue is real:
  is `team_send` nine acts behind one tool (coarse) or should acts be tools (fine)? RocketRide is a
  vote that coarse + well-described beats many fine tools for context economy.
- **Server-side conforming agent (nick's idea).** An agent/model on the MCP-server side that takes
  loosely-shaped client input and conforms it to the strict envelope shape, instead of bouncing an
  error. Honest read: the _goal_ (a forgiving surface) is right, and it pairs naturally with the
  Track B tiny-model fixture work (a local qwen-class model as coercion layer) — but a model in the
  request path buys latency, cost, and nondeterminism for a problem that deterministic code solves at
  our scale: lenient coercion in the handler (accept aliases, trim, default) plus increment-2's
  action-naming errors ("act must be one of …; you sent 'update' — closest is `status_update`") gets
  an agent to a valid retry in one turn. Verdict: adopt as **deterministic** lenient-input + repair-hinting
  in increments 2–3 now; keep the model-in-the-path variant as a researchable extension (good tiny-model
  dogfood) rather than a committed increment.

## Proposed increments (sequence, not yet frozen)

1. **Names & descriptions.** Audit all 18 tool names for one convention (resolve the `team_*` /
   `lane_*` split), and rewrite descriptions for concision — the cheapest, highest-leverage lever per
   the field evidence. Question whether `team_send`'s nine-act paragraph should be trimmed, moved to a
   linked resource, or split.
2. **Results & empty states.** Make every tool result — success, empty, and error — informative,
   intuitive, and action-naming for an agent, as an audited standard rather than ad hoc. Bring the bare
   ones ("no members") up to the level the good ones already set ("no lanes — lane_open to declare your
   work"), and make sure error/not-ready results say what to do next, not just what went wrong —
   including **repair hints** on invalid input ("act must be one of …; closest to what you sent is
   status_update"), so a confused agent reaches a valid retry in one turn. Decide the **result shape**
   deliberately: programmatic callers (GPT-5.6's `tools.*` runtime, code-execution harnesses) want
   structured returns with a documented `output_schema`; conversational callers want prose naming the
   next action — likely structured-first with the prose/next-action hint as a field, per tool.
3. **Schemas & tool shape.** Tighten input schemas; decide where overloaded tools (`team_send` carrying
   nine acts) should split, and where near-duplicate tools should merge — RocketRide and the Reddit
   thin-proxy fix are both votes that coarse + well-described can beat many fine tools. Two borrowable
   levers: `input_examples` (worked examples per act — Anthropic measured 72%→90% on complex
   parameters) instead of longer prose, and **deterministic lenient coercion** in the handler (accept
   aliases, trim, sensible defaults) so near-miss input conforms instead of bouncing.
4. **Scope by role.** The adapter renders only the tools a seat's role can meaningfully use — an
   observer never loads acting tools. Structural, enforced at render — and expressed as declarative
   role→tool data the render consumes (the OPA decoupling pattern, without the dependency). Scope must
   be **stable within a session**: a fixed per-seat surface stays prompt-cacheable; mutating the tool
   list mid-session invalidates the harness's cached prefix.
5. **Discovery / lazy disclosure.** A small always-on surface plus a `get_more_tools`-style retrieval
   entry, so the catalog can grow without taxing every call (the SkillWeaver / tool-RAG pattern). Note
   harnesses are building this natively (Anthropic's Tool Search Tool / `defer_loading`: 50+ tools
   ~72K→8.7K tokens _and_ accuracy up) — so the durable server-side work is names and descriptions that
   retrieve well, plus discovery-tier vs invocation-tier schemas if the MCP spec adopts them (#2808).

## A supporting input, split into its own item: measurement

Before proposing the above, checked whether we can already see how the surface is used. We cannot: the
audit ledger is coordination-level (claims, residency, merges), the `messages` table records **acts**
not tool invocations, and no row records which tool was called, its latency, or its schema-token cost
(the only token columns are `grants.token_hash`). PostHog's taxonomy defines `$mcp_tool_call` /
`$ai_generation` but the Sandrise project collects none of them. So a light instrumentation pass — which
tools each role actually calls, and what each description weighs — would tell us which parts of the
surface are earning their bytes.

This measurement is now its **own roadmap item, `tool-call-telemetry`** (observability), rather than a
sub-bullet here — it has value beyond the redesign (cost accounting, coordination density, the
MAST-in-the-wild dataset) and would otherwise be easy to forget. The surface redesign's increments 1–2
consume it; it does not gate them (naming and descriptions can start immediately). The lone precedent
that the ledger can carry a real measured cost is the inc-5 `residency.wake_cost` (~$1.21/wake).

## Where musterd already has the substrate

- **The per-seat adapter render (ADRs 029–031).** We already render a per-seat MCP server; renaming,
  reshaping, scoping, and lazy disclosure are all changes to what that renderer emits.
- **The agent-first result formatter (`format.ts`).** The output-quality increment is not a new
  subsystem — it is holding the whole surface to the standard `format.ts` already sets for the roster,
  and extending it to every tool's success/empty/error result.
- **Roles + grants (ADR 069) and role templates (`own-harness`, ADR 101).** The axis to scope a
  surface by — a role can declare the tools it needs.

## Open questions

- Is the `team_*` / `lane_*` split intentional (lanes as a distinct sub-surface) or accidental? The
  answer sets increment 1. (MCP spec issue #2808 proposes tool namespacing as a first-class mechanism —
  worth tracking before we pick.)
- ~~How much do harnesses already prompt-cache tool schemas?~~ Partially answered (see the adjacent-
  systems sweep): caching blunts the _cost_ of a stable prefix but not selection accuracy or context
  occupancy, and it makes mid-session surface mutation actively harmful. The open remainder: which of
  our harnesses run Tool-Search-style deferred loading today, and does that change increment 5's
  priority?
- Does scoping the surface by role interact with resume/residency, where a seat's role can change
  between sessions? (A role change between sessions is fine — the surface re-renders on connect; the
  cache constraint only forbids _mid-session_ mutation.)
- Is a model-in-the-path conforming layer (the server-side agent idea) ever worth its latency and
  nondeterminism at our scale, or does deterministic coercion + repair hints cover it permanently? A
  cheap experiment once tool-call-telemetry lands: count invalid-input bounces per tool; if a tool
  still bounces agents after increments 2–3, that is the candidate.
