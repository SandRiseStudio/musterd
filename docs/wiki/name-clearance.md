# Name clearance — musterd domains and the trademark neighborhood

musterd.io is the product's registered home as of 2026-08-13, the UK is the one jurisdiction with a true exact-mark blocker (Restranaut's registered MUSTERD in classes 9/42), and the US/EU registers are crowded-but-coexistent for the MUSTER/MUSTARD family — screening-grade findings, not legal clearance.

## Domains (checked 2026-08-13 via RDAP + whois; falsify: re-run `whois musterd.<tld>`)

**musterd.io is ours — registered 2026-08-13 at Cloudflare Registrar** (creation 2026-08-13T22:04:11Z, expiry 2027-08-13, on `chad`/`melody.ns.cloudflare.com`; falsify: `whois musterd.io`). It is the canonical domain. ~~Nothing is deployed on it yet.~~ LIVE 2026-08-13: the `packages/web` landing page (with the #815 Get Started section) serves from the Cloudflare Worker **`musterd-io`** — an assets-only Worker over `dist/client`'s landing route, custom domain attached, unknown paths 404 (the /live routes deliberately stay on the daemon origin, ADR 132/156). Deploy is currently manual (`wrangler deploy` of a staged `index.html` + `assets/`); the wrangler config is not yet in the repo (falsify: `packages/web/wrangler.jsonc` exists). Renewal falls due 2027-08-13 — the registration is auto-renew-capable at Cloudflare but that setting has not been verified from this seat.

Still unregistered at the 2026-08-13 check: **musterd.dev, musterd.sh, musterd.ai, musterd.co, musterd.team**, plus every compound tried (musterdlabs .com/.io/.ai, musterdhq.com, musterdteam.com, get/use/trymusterd.com).
Taken: **musterd.com** (Thinking Software / Restranaut Ltd — see below) and **musterd.app** (an unrelated free group-scheduling poll tool).

~~Recommendation given to nick: musterd.dev as primary, musterd.io/.ai as defensive redirects. None purchased as of 2026-08-13.~~ SUPERSEDED 2026-08-13: nick narrowed the choice to .ai vs .io and bought **.io**. The reasoning that decided it, worth keeping because it generalises to future naming calls: musterd is infrastructure, not an AI product — `.ai` claims category membership in the register [brand.md](../design/brand.md) §4 explicitly bans ("no revolutionary, magic, supercharge, 10x"), costs roughly double, and dates itself to this trend cycle. `.io` reads as developer infrastructure and doesn't. The one honest knock on `.io` is the Chagos-handover question over the ccTLD's long-term future, judged low-risk given registry continuity signals and any retirement's multi-year runway.

**Compound names were rejected on architecture, not taste.** "musterd labs" (or any musterd-\<suffix\> entity) would invent a second maker entity competing with SandRise Studio for the role [positioning](positioning.md) already assigns it, and would make the product name the parent of itself. `get-`/`use-`/`try-` prefixes exist to work around a taken bare name; ours was not taken.

## The two other Musterds (both live products, neither in our market)

- **musterd.com → thinking-software.com/musterd** (Restranaut Ltd, UK): cloud roll-call and **evacuation management** — "who is on site, and are they safe" from access-control data, positioned on UK safety law (Martyn's Law). Same etymology as ours (muster = roll call = presence), physical-safety domain.
- **musterd.app**: group scheduling polls (a Doodle-alike). Consumer utility.

No product or channel overlap with an agent-coordination dev tool; the conceptual echo (presence, roll call) is coincidence doing its job.

## Trademark screen (TMview, 2026-08-13; falsify: re-run tmdn.org/tmview searches for "musterd", "muster", "mustard")

Method: TMview (the EUIPN aggregator over USPTO/EUIPO/UKIPO/~70 registries), "contains" search on three stems, filtered to software classes **9/42**, first 60 relevance-ranked rows of each set reviewed ("muster": 283 total; "mustard": 109). TMview is not an official register; no common-law search; no similarity algorithm beyond the two phonetic stems.

### Exact mark: MUSTERD

Only two live registrations worldwide, both UK, both **Restranaut Limited**, both classes 9/42: UK00003044141 (filed 2014) and UK00003130178 (filed 2015). No US, EU, or other-jurisdiction MUSTERD exists (the two Indian "musterd" marks are textiles and mustard oil).

### The family in classes 9/42, live marks only

- **US:** MUSTER (Meridien Media LLC, cl. 42, reg. 2014 — advocacy-comms SaaS) and MUSTARD (Qualiaos Inc., cl. 42 reg. 2020, companion filing 9/35/41). MUSTER CONNECTIVE (35/42) filed 2026-07, pending. Notably, the phonetic near-twins MUSTER and MUSTARD **already coexist registered in class 42 under different owners** — the classic crowded-field posture, which narrows every member's scope and supports one more coexistent with distinct services.
- **UK:** crowded and hostile — beyond Restranaut's exact MUSTERD ×2: MUSTER (Kay-Lambert Associates, 9/41/42, 2022), Muster (Warr Studios, 9/42/45, 2017), Muster (Tim Lambert, 9/42/45, 2020), plus live MUSTARD marks (Absolute Mustard 9/35/42; Mustard IT 37/42; Mustard Group 35/38/41/42).
- **EU:** cleanest of the three — no live plain MUSTER/MUSTERD/MUSTARD EUTM in 9/42 surfaced; only composites (MUSTER DER VIELFALT — Berlin transit; MUSTARD LOVERS — food) and expired marks. Structural helper: _Muster_ is an ordinary German word ("pattern/sample"), depressing bare-word distinctiveness EU-wide.
- **Open flag:** SOPHiA GENETICS holds MUSTARD (9/42/44) via WIPO international registration 1758373 (Swiss base) — whether its designations reach the EU or US was not visible in the screen; resolve with counsel before filing.
- **Phonetic long tail sighted:** MUSTR (Canada, Adyton PBC — a military mustering app), "Mustered" (Australia, 9/42, filed 2026-05), OpsMuster/betmuster (Australia, filed 2026).

## What this means (assessment, 2026-08-13)

1. **Keep the name.** The family is coexistence-tolerant everywhere except the UK.
2. **OSS launch worldwide is low practical risk** — GitHub/npm/brew distribution of a free dev tool is not the enforcement scenario; risk concentrates at UK commercial go-to-market or a UK filing.
3. **If registering: EUTM first, US second (attorney-drafted services description, e.g. "software for coordinating persistent teams of AI agents and humans"), UK never.**
4. **Before the launch post travels widely**, an attorney clearance (similar-marks analysis + US common-law + the WIPO-designation flag) is a few hundred dollars well spent.

Related: [positioning](positioning.md) (brand architecture: musterd stands on its own name; SandRise Studio is the maker).
