# Verifying web changes in the Browser pane

The in-app Browser pane lies in three specific ways — a stale vite preview, a permanently hidden document, and React-batched clicks — and each one reads as "my change broke the page" when nothing is wrong.

## The traps (2026-07-28, each cost real time; falsify: reproduce in the Browser pane)

- **`vite preview` caches dist at server start** — after every web build, stop and restart the preview or the served HTML points at chunk hashes that 404 and the page renders blank with no console error (~30 min lost to a false "my change broke the route").
- **The Browser pane always reports `document.hidden === true`**, so visibility-gated code appears dead. Override the getter (`Object.defineProperty(document, 'hidden', {get: () => !window.__visible})`) and dispatch `visibilitychange` to exercise both branches.
- **Two `.click()`s in one JS statement are batched by React** — both read the same stale state, so a toggle appears broken. Click, return, then read.
- `computer {action:'zoom'}` is not supported in the pane — to inspect a region of a tall canvas, `drawImage` the crop into a `position:fixed` overlay canvas on a rAF loop.
