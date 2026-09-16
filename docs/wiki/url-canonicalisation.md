# URL canonicalisation — one spelling returns 200, and it is the one we publish

musterd.io served every page at two URLs and told Google to index the wrong one, which cost the home page a month of not being indexed at all; the rule that prevents it is that exactly one spelling of a URL returns 200, and it is the spelling the site publishes.

## The rule

A page has a canonical tag, an `og:url`, a `sitemap.xml` entry, and an address the server actually answers 200 on. **Those four must be the same string.** When they are not, the extra spelling is a duplicate, and Google picks the canonical itself rather than believing the tag — the tag is a hint, and it loses to a URL that answers 200.

Two failures of this rule hit the same site three weeks apart, in different layers. Neither was visible in a browser, in a screenshot, or in any test the repo had: both pages rendered perfectly, and only the relationship between files was wrong.

## The home page was unindexed for a month because plain HTTP answered 200 (2026-09-16; falsify: `curl -sI http://musterd.io/` — a 200 means the defect is back, a 301 means it holds) <!-- claim: defect -->

Cloudflare's `always_use_https` was **off** on zone `670797fd28c7e46c1a1731715e86b9bb`, so `http://musterd.io/` and `http://musterd.io/docs/` both returned **200** instead of redirecting. Every page existed at two addresses, and Google chose the insecure one.

URL Inspection on `https://musterd.io/`, before the fix:

| Field | Value |
| --- | --- |
| Status | URL is not on Google |
| Reason | Duplicate without user-selected canonical |
| Google-selected canonical | `http://musterd.io/` |
| User-declared canonical | None |
| HTTPS | HTTPS is invalid and might prevent it from being indexed |
| Last crawl | 2026-08-18 15:24:54 |

The canonical tag was **present and correct the whole time** (`<link rel="canonical" href="https://musterd.io/">` on both the HTTP and HTTPS renderings), and the TLS certificate was valid — Google Trust Services, `notAfter` 2026-11-11. Neither saved it. A correct tag does not beat a duplicate that answers 200.

**The fix was one zone setting and the next crawl settled it.** `always_use_https` on at **2026-09-16 04:30:56Z (21:30:56 PDT)**; the crawl that indexed the page is stamped **21:37:54 PDT** — seven minutes later. Afterwards the same inspection reads "URL is on Google / Page is indexed", user-declared canonical `https://musterd.io/`, Google-selected canonical "Inspected URL", HTTPS "Page is served over HTTPS".

That seven-minute gap is the whole evidence that the diagnosis was right rather than coincidental, which is why the timestamp is recorded here and not just the outcome.

## The visible symptom pointed at the wrong cause, and the wrong cause was plausible (2026-09-16; falsify: fetch the page as Googlebot and grep the served HTML for the spam string) <!-- claim: other -->

Searching `musterd.io` returned the home page titled **"BK8 GG 🎖️【Nhà cái BK8】| Link Đăng Nhập BK8 2025 tại musterd.io"**. The obvious reading — a stale index from the domain's prior life, needing a reindex request and possibly a penalty appeal — was **wrong**, and acting on it alone would have fixed nothing.

What ruled it out, and what to run before believing that story about any domain:

- `curl -A "…Googlebot/2.1…" https://musterd.io/` returns `<title>musterd</title>`. Not cloaking on our side.
- `curl -sL https://musterd.io/ | grep -aic bk8` → **0**. The string is in no served byte.
- Search Console **Security issues** and **Manual actions** both read "No issues detected". No penalty, nothing to appeal.

The domain does have a prior life — Wayback has 2018 snapshots and four 2025-03-27 captures before our 2025-08-23 redirect, and Google still lists a [r/Scams](https://www.reddit.com/r/Scams/comments/85e672/micro_investment_app_is_it_a_rotating_scam/) thread and a MacObserver article as referring pages, from a micro-investment app also called Musterd. All of that is true and none of it was the cause. **A plausible history is not a diagnosis**: the inspection tool said something better and more specific, and it disagreed with the story.

## Every docs page told Google to index a URL that redirects (2026-09-16, lane 01M2NGD759, #1469 / `38ca7c01`; falsify: `curl -sI https://musterd.io/docs/spec` — 200 holds, 307 means it regressed) <!-- claim: defect -->

Fixing the HTTP duplicate surfaced the same defect one layer down, in our own asset config. The prerender emits `docs/spec/index.html`, and Workers Assets' default `html_handling: "auto-trailing-slash"` serves that at `/docs/spec/` while `/docs/spec` answers **307**. Meanwhile `siteUrls()` put `/docs/spec` in the sitemap and `pageHead` put `/docs/spec` in the canonical:

```
sitemap says /docs/spec  ->  307  ->  /docs/spec/  ->  canonical says /docs/spec  ->  307 ...
```

The canonical target was never a page that returns 200. All four docs pages, identically.

Two things were wrong and either alone is a defect. The canonical did not match the served URL. And the redirect was **307, temporary** — which tells Google specifically *not* to consolidate signals onto the target, the opposite of what a slash normalisation wants.

**Fixed with `"html_handling": "drop-trailing-slash"`** in `packages/web/wrangler.jsonc` — the half of the pair that needs no URL to change, so `/docs/spec` serves the page and `/docs/spec/` redirects to it. Every URL string already emitted, and already submitted to Search Console that morning, became correct instead of needing a rewrite. Verified after the deploy (`musterd-io` version `94c03efd`): all five published URLs 200, all four slash forms 307 to them, every canonical equal to the URL serving it, every `<loc>` in `sitemap.xml` a 200.

**Cost of the delay, and the reason to fix before requesting indexing.** Google crawled the docs pages at **09:21:23–09:29:25 PDT on 2026-09-16** — in the window between the indexing requests and the deploy — and recorded **"Page is not indexed: Redirect error"** on all four. The first request was spent on a crawl of the broken state and had to be re-issued. A crawl request is not free; land the fix first.

## What now checks this, and what does not

`packages/web/src/routes/site-routes.test.ts` pins the relationship between the three files that disagreed — the asset config, the sitemap builder, and the canonical builder. It asserts no published path carries a trailing slash, that `wrangler.jsonc` therefore declares `drop-trailing-slash`, that `absoluteUrl(path)` equals the published form for every sitemap URL, and that `not_found_handling` stays `"none"` (an SPA fallback would make *any* misspelling return 200 — an unbounded supply of duplicates for every page).

**Verified the test fails when the defect returns**, rather than assuming it would — restoring `auto-trailing-slash` produces:

```
× the asset server serves the same URL spelling the sitemap and canonical advertise
  → published URLs have no trailing slash, so html_handling must be "drop-trailing-slash"
    — the default serves them as 307 redirects to a URL we advertise nowhere
```

A gate nobody has watched fail is not known to be a gate.

**Nothing in this repo checks the zone state (2026-09-16; falsify: `grep -rl always_use_https packages/ scripts/` — a hit means a gate now exists)** <!-- claim: defect -->

The HTTP-to-HTTPS redirect, HSTS and the TLS floor live in Cloudflare, not in the repo, so no test here would notice `always_use_https` being switched off again. The `curl` line in the first section is the only falsifier, and it has to be run by hand.

## Measurement traps that produce confident wrong numbers

Each of these returned a clean, plausible, wrong answer during this work.

- **`grep` goes silent on the prerendered HTML.** `file` reports it as `data`, so plain `grep` finds nothing, counts nothing and exits 1 — indistinguishable from "the string is absent". Use **`grep -a`**. This nearly produced a report that the analytics beacon was missing when it was there.
- **`curl` without `-L` reads a redirect, not the page.** Before the fix every docs URL 307'd, so a bare `curl` of `/docs/spec` measured the redirect's empty body. Use **`curl -L`**, or measure the URL that actually answers 200.
- **macOS system `curl` cannot speak TLS 1.3 at all.** It is built on LibreSSL, so `curl --tlsv1.3` returns `000` and reads exactly like a broken server. Verify TLS with `openssl s_client -tls1_3` instead: the real result was `New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384`, and TLS 1.1 correctly refused with `alert number 70`.

## Zone state and Search Console, as of 2026-09-16

Cloudflare zone `musterd.io` (`670797fd28c7e46c1a1731715e86b9bb`): `always_use_https` on, HSTS on at `max-age=15552000` with **no** `includeSubDomains` and **no** preload (the zone has no subdomain A/AAAA records, but a future one would break under either), `min_tls_version` raised 1.0 → 1.2, `ssl` full, `not_found_handling` none.

Search Console is a **Domain property** (`sc-domain:musterd.io`), verified by DNS TXT. `sitemap.xml` submitted and reading Success / 5 pages; the prior owner's `sitemap_index.xml` (submitted 2025-04-10, last read 2025-07-14, "Couldn't fetch", 0 pages) was removed.

**Search Console needs a human (2026-09-16; falsify: try to reach `search.google.com/search-console` from a seat with no shared browser session)** <!-- claim: other -->

It sits behind a Google sign-in. Verification, URL inspection, indexing requests and the Security & Manual Actions panels all need the account holder — either acting, or sharing a logged-in browser the seat drives. Everything on the Cloudflare and repo side a seat does unaided.

## Related

- [Web performance](web-performance.md) — the byte gate, and the page height it does not measure. Same shape as this page: a gate covers what it covers, and the gap is where the next one hides.
- `docs/design/watch-page-copy-spec.md` — the `/watch` page this work was a prerequisite for; its §1 records the wrong first reading beside the real cause, deliberately.
