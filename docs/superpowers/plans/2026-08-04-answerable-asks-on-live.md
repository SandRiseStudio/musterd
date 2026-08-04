# Answerable asks on /live — Implementation Plan

> **For agentic workers:** implement task-by-task in your own musterd lane. Steps use checkbox (`- [ ]`) syntax for tracking. Do **not** dispatch writing subagents (global CLAUDE.md): a lane per unit of work, a `handoff` per owner.

**Goal:** A human watching `/live` can sign in as themselves and answer the asks that are waiting on them, from the office, without handling a secret.

**Architecture:** Identity becomes per browser + team rather than per route — one `musterd.member.v1.<team>` slot that `/live` and `/board` both prefer over an auto observer. `/live` gains the member slot it never had, the asks rail gains a sign-in affordance in the slot the answer will occupy, and a new localhost-gated daemon route hands the page the identity the CLI already holds so the one-click path needs no nonce.

**Tech Stack:** TypeScript, React + TanStack Router (`packages/web`), Node HTTP daemon (`packages/server`), vitest, zod at every wire boundary.

**Spec:** [docs/superpowers/specs/2026-08-04-answerable-asks-on-live-design.md](../specs/2026-08-04-answerable-asks-on-live-design.md)

## Global Constraints

- **ADR number is 221**, allocated with `pnpm adr:next`. **Do not read `origin/main` by hand** — main by construction holds no in-flight work, so two authors reading it correctly compute the same free number and are both wrong. This arc lost 219 to izzo (#628) and then 220 to stanley (#630) exactly that way, and #630 is the ADR that added `pnpm adr:next` to end it. Re-run the tool at PR time. `pnpm adr-numbers:check` fails on a duplicate number or an H1 that does not match the filename.
- **Every ADR ≥060 needs an `## Observability & Evaluation` section** or the doc gate fails.
- **The rail costs the canvas exactly one line, in every state** (ADR 149). No state earns extra rows.
- **Perf gate:** `pnpm perf:check` enforces byte budgets. This arc adds no dependency and no font. Do not raise a budget.
- **`pnpm lint` is a separate gate from `format:check`** — run both. Build before typecheck (phantom `.d.ts` errors otherwise).
- **Never run `pnpm format`** — use `pnpm exec prettier --write <your files>`.
- **Never log a credential**, and never log the identity-vault path, in any audit row or error.
- **Git loop:** branch from fresh main → PR → `gh pr merge --squash --auto --delete-branch` → rebase + `--force-with-lease`, never merge.
- Tests run from the repo root only (`pnpm vitest run <path>`).

## File Structure

| File                                            | Responsibility                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `docs/decisions/221-answerable-asks-on-live.md` | Create — the decision, the measured zero baseline, the boundary.                                                              |
| `packages/web/src/live/memberIdentity.ts`       | Create — the single per-team member identity slot: load/save/forget + the legacy board-key migration. Pure storage, no React. |
| `packages/web/src/live/memberIdentity.test.ts`  | Create — precedence and migration tests.                                                                                      |
| `packages/web/src/routes/board.tsx`             | Modify — read/write through `memberIdentity` instead of its private `MEMBER_KEY`.                                             |
| `packages/web/src/routes/live.tsx`              | Modify — the precedence chain (watch link > member > observer), member-401 handling, sign-in plumbing.                        |
| `packages/web/src/live/AsksStrip.tsx`           | Modify — the action-slot sign-in, the seat chip, disable-on-any-answer.                                                       |
| `packages/web/src/live/Live.css`                | Modify — `.lc-asks__signin`, `.lc-asks__me`.                                                                                  |
| `packages/server/src/config.ts`                 | Modify — `readLocalIdentity(team, env)` beside the existing `resolveRosterRoots`.                                             |
| `packages/server/src/transport/http.ts`         | Modify — `GET /teams/:slug/local-identity`.                                                                                   |
| `packages/server/src/store/audit.ts`            | Modify — two new `AuditAction` members.                                                                                       |
| `packages/cli/src/commands/board.ts`            | Modify — `signinUrl` gains a surface parameter; `boardCommand` generalises.                                                   |
| `packages/cli/src/commands/live.ts`             | Create — `musterd live`.                                                                                                      |

`memberIdentity.ts` is deliberately its own module rather than more surface on `client.ts` (676 lines already): it is the one thing three consumers share, and a reviewer should be able to read the whole identity rule in one screen.

---

### Task 1: ADR 221

**Files:**

- Create: `docs/decisions/221-answerable-asks-on-live.md`

**Interfaces:**

- Produces: the ADR number every later commit message references.

- [ ] **Step 1: Re-confirm the number is still free**

```bash
pnpm adr:next
```

Expected: `next free ADR number: 221`. It allocates against the working tree, `origin/main` **and every open PR** — which is the point, and why the hand-rolled `git ls-tree` sweep this step used to carry is wrong: it cannot see a number claimed in a branch that has not been pushed as a PR yet. If the tool says something other than 221, take that number and update every reference in this plan.

- [ ] **Step 2: Write the ADR**

H1 must be exactly `# 220 — Answerable asks on /live: the surface a human watches is the one they can act on`, matching the filename. Carry over from the spec, in this order: Context (the ADR 149 read-only-by-design decision and the transition it never specified), Problem, the measured baseline table, Decision (the four numbered parts), the two constraints nick raised, Consequences, Alternatives considered, `## Observability & Evaluation`, Increments.

State the layering question honestly and then resolve it: the daemon already reads `~/.musterd/config.json` in `resolveRosterRoots` ([packages/server/src/config.ts:81](../../../packages/server/src/config.ts)), whose own comment gives the rationale — _"Reading the global config keeps the daemon decoupled from the CLI package while sharing the `~/.musterd/` home the db already lives in."_ The new reader is the same pattern applied to a second key, not a new coupling.

- [ ] **Step 3: Run the doc gates**

Run: `pnpm adr-numbers:check && pnpm vocab:check`
Expected: PASS. `vocab:check` fails on `epic`/`milestone`/`sprint` — say Goal, Lane, increment.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write docs/decisions/221-answerable-asks-on-live.md
git add docs/decisions/221-answerable-asks-on-live.md
git commit -m "ADR 221: answerable asks on /live"
```

---

### Task 2: The shared member identity slot

**Files:**

- Create: `packages/web/src/live/memberIdentity.ts`
- Test: `packages/web/src/live/memberIdentity.test.ts`

**Interfaces:**

- Produces: `MemberIdentity = { as: string; token: string }`, `loadMemberIdentity(team: string): MemberIdentity | null`, `saveMemberIdentity(team: string, id: MemberIdentity): void`, `forgetMemberIdentity(team: string): void`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/live/memberIdentity.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetMemberIdentity, loadMemberIdentity, saveMemberIdentity } from './memberIdentity';

const LEGACY = (team: string) => `musterd.board.member.v1.${team}`;
const CURRENT = (team: string) => `musterd.member.v1.${team}`;

describe('memberIdentity', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips an identity under the shared per-team key', () => {
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_abc' });
    expect(window.localStorage.getItem(CURRENT('revive'))).toBeTruthy();
    expect(loadMemberIdentity('revive')).toEqual({ as: 'nick', token: 'mscr_abc' });
  });

  it('keeps teams apart so two projects on one machine never cross', () => {
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_a' });
    saveMemberIdentity('other', { as: 'nsanders', token: 'mscr_b' });
    expect(loadMemberIdentity('revive')?.as).toBe('nick');
    expect(loadMemberIdentity('other')?.as).toBe('nsanders');
  });

  it("migrates /board's legacy key on read, then writes it forward", () => {
    window.localStorage.setItem(
      LEGACY('revive'),
      JSON.stringify({ as: 'nick', token: 'mscr_legacy' }),
    );
    expect(loadMemberIdentity('revive')).toEqual({ as: 'nick', token: 'mscr_legacy' });
    expect(window.localStorage.getItem(CURRENT('revive'))).toBeTruthy();
  });

  it('prefers the current key when both exist', () => {
    window.localStorage.setItem(LEGACY('revive'), JSON.stringify({ as: 'old', token: 'mscr_old' }));
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_new' });
    expect(loadMemberIdentity('revive')?.as).toBe('nick');
  });

  it('returns null for absent, malformed, and half-shaped records', () => {
    expect(loadMemberIdentity('revive')).toBeNull();
    window.localStorage.setItem(CURRENT('revive'), 'not json');
    expect(loadMemberIdentity('revive')).toBeNull();
    window.localStorage.setItem(CURRENT('revive'), JSON.stringify({ as: 'nick' }));
    expect(loadMemberIdentity('revive')).toBeNull();
  });

  it('forget clears both the current and the legacy key', () => {
    window.localStorage.setItem(LEGACY('revive'), JSON.stringify({ as: 'x', token: 'mscr_x' }));
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_a' });
    forgetMemberIdentity('revive');
    expect(loadMemberIdentity('revive')).toBeNull();
    expect(window.localStorage.getItem(LEGACY('revive'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/web/src/live/memberIdentity.test.ts`
Expected: FAIL — cannot resolve `./memberIdentity`.

- [ ] **Step 3: Implement**

```ts
// packages/web/src/live/memberIdentity.ts
/**
 * The signed-in member identity for a team — **one slot per browser per team, shared by every
 * route** (ADR 221). /live and /board used to keep separate ideas of who you are, and /live's was
 * always an observer, so the office could show you what was waiting on you and never let you answer
 * it.
 *
 * Keyed by team, not by route: with several projects on one machine you may be `nick` on one team
 * and someone else on another, and approving as the wrong identity is unrecoverable. Separate
 * daemons already mean separate origins (ADR 039 — one team, one daemon), so this is belt-and-braces
 * on top of an isolation that already holds.
 */
export interface MemberIdentity {
  as: string;
  /** The member's credential (mscr_) — HTTP Bearer and the ADR 077 WS claim key. */
  token: string;
}

const memberKey = (team: string) => `musterd.member.v1.${team}`;
/** /board's private key before this was shared. Read once, migrated forward, then dropped. */
const legacyBoardKey = (team: string) => `musterd.board.member.v1.${team}`;

function parse(raw: string | null): MemberIdentity | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { as?: unknown; token?: unknown };
    return typeof v.as === 'string' && typeof v.token === 'string'
      ? { as: v.as, token: v.token }
      : null;
  } catch {
    return null;
  }
}

export function loadMemberIdentity(team: string): MemberIdentity | null {
  if (typeof window === 'undefined') return null;
  try {
    const current = parse(window.localStorage.getItem(memberKey(team)));
    if (current) return current;
    // Migrate on read so a human already signed into /board is signed into /live the first time
    // they open it — the whole point of one slot.
    const legacy = parse(window.localStorage.getItem(legacyBoardKey(team)));
    if (legacy) saveMemberIdentity(team, legacy);
    return legacy;
  } catch {
    return null;
  }
}

export function saveMemberIdentity(team: string, id: MemberIdentity): void {
  try {
    window.localStorage.setItem(memberKey(team), JSON.stringify(id));
  } catch {
    /* private mode — the session still works, it just won't be remembered */
  }
}

export function forgetMemberIdentity(team: string): void {
  try {
    window.localStorage.removeItem(memberKey(team));
    window.localStorage.removeItem(legacyBoardKey(team));
  } catch {
    /* private mode */
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/web/src/live/memberIdentity.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/web/src/live/memberIdentity.ts packages/web/src/live/memberIdentity.test.ts
git add packages/web/src/live/memberIdentity.ts packages/web/src/live/memberIdentity.test.ts
git commit -m "One member identity slot per browser per team (ADR 221)"
```

---

### Task 3: /board reads through the shared slot

**Files:**

- Modify: `packages/web/src/routes/board.tsx:42-56` (delete `MEMBER_KEY` + `loadMember`), `:87`, `:165`, `:194`, `:238`

**Interfaces:**

- Consumes: `loadMemberIdentity`, `saveMemberIdentity`, `forgetMemberIdentity` from Task 2.

- [ ] **Step 1: Replace the private key with the shared module**

Delete the `MEMBER_KEY` constant and the local `loadMember` function at `board.tsx:42-56`. Add to the existing `../live/...` import block:

```ts
import {
  forgetMemberIdentity,
  loadMemberIdentity,
  saveMemberIdentity,
} from '../live/memberIdentity';
```

Then four call-site swaps:

- `:87` `window.localStorage.removeItem(MEMBER_KEY(current.team))` → `forgetMemberIdentity(current.team)`
- `:165` `window.localStorage.setItem(MEMBER_KEY(slug), JSON.stringify(member))` → `saveMemberIdentity(slug, member)`
- `:194` `if (cfg) window.localStorage.removeItem(MEMBER_KEY(cfg.team))` → `if (cfg) forgetMemberIdentity(cfg.team)`
- `:238` `loadMember(urlTeam)` → `loadMemberIdentity(urlTeam)`

- [ ] **Step 2: Typecheck and run the board tests**

Run: `pnpm build && pnpm typecheck && pnpm vitest run packages/web/src/live/boardWrite.test.ts`
Expected: PASS, no reference to `MEMBER_KEY` remains (`grep -rn "MEMBER_KEY" packages/web/src` returns nothing).

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write packages/web/src/routes/board.tsx
git add packages/web/src/routes/board.tsx
git commit -m "/board reads its identity from the shared slot (ADR 221)"
```

---

### Task 4: /live gains a member identity and its precedence chain

**Files:**

- Modify: `packages/web/src/routes/live.tsx` — `watch()` at `:131-160`, `recoverObserver` at `:84-115`, the URL hydration effect at `:191-227`

**Interfaces:**

- Consumes: Task 2's module.
- Produces: a `signedIn: boolean` React state in `LivePage`, and `signIn(team, id)` / `signOut()` callbacks passed to `AsksStrip` in Task 5.

- [ ] **Step 1: Write the failing test for the precedence rule**

The rule is pure, so extract and test it rather than testing the component. Add to `packages/web/src/live/memberIdentity.test.ts`:

```ts
import { resolveIdentity } from './memberIdentity';

describe('resolveIdentity — the precedence chain', () => {
  beforeEach(() => window.localStorage.clear());

  it('an explicit watch link beats a stored member — it is how the team hands the office over', () => {
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_member' });
    expect(resolveIdentity('revive', { as: 'watcher', token: 'mscr_watch' })).toEqual({
      kind: 'watch',
      as: 'watcher',
      token: 'mscr_watch',
    });
  });

  it('a stored member beats an auto observer', () => {
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_member' });
    expect(resolveIdentity('revive', null)).toEqual({
      kind: 'member',
      as: 'nick',
      token: 'mscr_member',
    });
  });

  it('falls through to the observer when nothing is stored', () => {
    expect(resolveIdentity('revive', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/web/src/live/memberIdentity.test.ts`
Expected: FAIL — `resolveIdentity` is not exported.

- [ ] **Step 3: Add `resolveIdentity` to `memberIdentity.ts`**

```ts
/** How the connected seat was chosen — the rail needs this to know whether it may answer. */
export type ResolvedIdentity =
  | { kind: 'member'; as: string; token: string }
  | { kind: 'watch'; as: string; token: string };

/**
 * The total precedence order for who this page connects as (ADR 221):
 *   1. an explicit watch link (`?as=…#w=…`) — a URL instruction, and how a team deliberately hands
 *      the office to someone else; it must never be overridden by whoever last signed in here;
 *   2. the stored member identity for this team;
 *   3. `null` — the caller provisions an auto observer.
 */
export function resolveIdentity(
  team: string,
  watchLink: { as: string; token: string } | null,
): ResolvedIdentity | null {
  if (watchLink) return { kind: 'watch', ...watchLink };
  const member = loadMemberIdentity(team);
  return member ? { kind: 'member', as: member.as, token: member.token } : null;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/web/src/live/memberIdentity.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire the chain into `live.tsx`**

In `LivePage`, add state and callbacks:

```ts
const [signedIn, setSignedIn] = useState(false);

const signIn = useCallback((slug: string, id: { as: string; token: string }) => {
  saveMemberIdentity(slug, id);
  setSignedIn(true);
  setCfg({ team: slug, as: id.as, token: id.token });
}, []);

const signOut = useCallback(() => {
  setCfg((current) => {
    if (!current) return current;
    forgetMemberIdentity(current.team);
    setSignedIn(false);
    void acquireObserver(current.team).then(setCfg, () => undefined);
    return null;
  });
}, []);
```

In `watch()` at `:145`, before the observer fallback (`let creds = loadObserver(slug)`), insert:

```ts
// A remembered member identity outranks this browser's observer: if you have signed in on this
// browser you are yourself, on every surface, until you say otherwise.
const member = loadMemberIdentity(slug);
if (member) {
  setSignedIn(true);
  setCfg({ team: slug, as: member.as, token: member.token });
  return;
}
setSignedIn(false);
```

In the URL hydration effect, the `?as=…#w=…` branch at `:213` already sets cfg directly — add `setSignedIn(false)` inside it, because a watch link is explicitly not you.

- [ ] **Step 6: Make an expired member credential say so**

`recoverObserver` at `:84` currently reprovisions an observer on any 401. Silently doing that to a _member_ would remove the answer buttons again — the exact defect this arc fixes. Guard it:

```ts
const recoverObserver = useCallback(() => {
  if (signedIn) {
    // Do not silently demote a signed-in human to an observer: that is how the buttons vanished in
    // the first place. Drop the dead credential, fall back to watching, and say what happened.
    const slug = cfgRef.current?.team;
    if (slug) forgetMemberIdentity(slug);
    setSignedIn(false);
    setFormError('your sign-in expired — sign in again to answer asks');
    if (slug) void acquireObserver(slug).then(setCfg, () => undefined);
    return;
  }
  /* …existing observer self-heal, unchanged… */
}, [signedIn]);
```

Add `const cfgRef = useRef(cfg); useEffect(() => { cfgRef.current = cfg; }, [cfg]);` above it — the callback is memoised and must not close over a stale `cfg`.

- [ ] **Step 7: Verify in the browser**

Run: `pnpm build && pnpm --filter @musterd/web preview`

**Trap:** `vite preview` caches `dist` at start — restart it after **every** build or pages go blank with 404'd chunks.

Open `/live?team=<slug>`, sign into `/board` first with a member credential, then reload `/live`. Expected: `/live` connects as that member without being asked. Confirm with `localStorage.getItem('musterd.member.v1.<slug>')` in the console.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write packages/web/src/routes/live.tsx packages/web/src/live/memberIdentity.ts packages/web/src/live/memberIdentity.test.ts
git add packages/web/src/routes/live.tsx packages/web/src/live/memberIdentity.ts packages/web/src/live/memberIdentity.test.ts
git commit -m "/live prefers a signed-in member over an observer (ADR 221)"
```

---

### Task 5: The rail states the state and offers the way in

**Files:**

- Modify: `packages/web/src/live/AsksStrip.tsx:26-242`
- Modify: `packages/web/src/live/Live.css` (after `.lc-ask__btn--later`, ~`:4443`)
- Modify: `packages/web/src/routes/live.tsx:323`, `packages/web/src/routes/asks-preview.tsx:176` (new props)

**Interfaces:**

- Consumes: `signedIn`, `signIn`, `signOut` from Task 4.
- Produces: `AsksStrip` props `signedIn: boolean`, `onSignIn: () => void`, `onSignOut: () => void`, `localIdentity: string | null` (Task 8 fills the last one; pass `null` until then).

- [ ] **Step 1: Extend the props and derive the four states**

Replace the `canAnswer` line at `:93`:

```ts
// Answerable iff the connected seat is a real roster member — an observer is read-only by
// construction (ADR 063). What is new (ADR 221) is that not-answerable is a *state we show*, not a
// silence: the action slot always says either what you can do or how to become able to.
const canAnswer = roster.some((m) => m.name === cfg.as);
```

Add below it:

```ts
/**
 * What the action slot holds when you cannot answer. `offer` is the one-click path (the daemon
 * confirmed a local identity on this machine); `paste` is the honest fallback off-machine, where
 * handing back a credential would hand admin B admin A's identity; `none` is a watch link, where
 * the team deliberately gave this viewer a read-only view and a sign-in prompt would be a nag.
 */
const wayIn: 'offer' | 'paste' | 'none' = watchLink ? 'none' : localIdentity ? 'offer' : 'paste';
```

- [ ] **Step 2: Render the sign-in slot and the seat chip**

In the rail, replace the `{askIsLoud(lead.state) && canAnswer && (…)}` block with:

```tsx
{
  askIsLoud(lead.state) && canAnswer && (
    <span className="lc-asks__quick">{/* …the existing Approve/Deny buttons, unchanged… */}</span>
  );
}
{
  askIsLoud(lead.state) && !canAnswer && wayIn === 'offer' && (
    <button type="button" className="lc-ask__btn lc-asks__signin" onClick={onSignIn}>
      Sign in as {localIdentity} to answer
    </button>
  );
}
{
  askIsLoud(lead.state) && !canAnswer && wayIn === 'paste' && (
    <button type="button" className="lc-ask__btn lc-asks__signin--ghost" onClick={onSignIn}>
      sign in with a credential →
    </button>
  );
}
```

And immediately before the closing `</div>` of `lc-asks__rail`, after the `seat approvals` link:

```tsx
{
  /* Who you are about to answer as. Not decoration: with several teams on one machine you may be a
    different person on each, and approving as the wrong identity is unrecoverable. */
}
<button
  type="button"
  className="lc-asks__me"
  onClick={canAnswer ? onSignOut : undefined}
  title={canAnswer ? 'watch as an observer instead' : 'watching — not signed in'}
>
  {canAnswer ? `${cfg.as} · ${cfg.team}` : 'watching'}
</button>;
```

- [ ] **Step 3: Add the styles**

```css
/* The way in sits where the answer will sit, so one click swaps it for Approve/Deny in place and
   the rail never moves. Accent, not success/danger: it is not itself an answer. */
.lc-asks__signin {
  color: var(--lc-accent);
  border-color: color-mix(in srgb, var(--lc-accent) 50%, transparent);
  background: color-mix(in srgb, var(--lc-accent) 12%, var(--lc-surface-2));
  font-weight: 600;
}
/* Off-machine there is no one-click path to offer, so the invitation drops to a ghost rather than
   dressing a paste form up as something it is not. */
.lc-asks__signin--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--lc-faint);
}
.lc-asks__me {
  display: inline-flex;
  align-items: center;
  gap: var(--lc-2);
  flex: none;
  font: inherit;
  font-size: 10px;
  color: var(--lc-muted);
  padding: var(--lc-1) 7px;
  border-radius: 999px;
  border: 1px solid var(--lc-border);
  background: var(--lc-surface-2);
  white-space: nowrap;
}
.lc-asks__me:not(:disabled) {
  cursor: pointer;
}
```

- [ ] **Step 4: Pass the new props at both call sites**

`live.tsx:323`:

```tsx
topSlot={
  <AsksStrip
    envelopes={envelopes}
    roster={roster}
    cfg={cfg!}
    signedIn={signedIn}
    localIdentity={null}
    onSignIn={() => setAdvanced((a) => ({ ...a, open: true }))}
    onSignOut={signOut}
  />
}
```

`asks-preview.tsx:176` gets `signedIn={false} localIdentity={null} onSignIn={() => {}} onSignOut={() => {}}`.

- [ ] **Step 5: Verify all four states in the browser**

Run: `pnpm build && pnpm --filter @musterd/web preview` (restart preview after the build).

Check, in order: signed out on-machine → the ghost paste button and a `watching` chip; signed in → Approve/Deny/Deciding and a `nick · <team>` chip; a watch link → no sign-in affordance at all. Screenshot the rail in each state. Confirm the rail is still exactly one line at 1280px and at 380px.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/web/src/live/AsksStrip.tsx packages/web/src/live/Live.css packages/web/src/routes/live.tsx packages/web/src/routes/asks-preview.tsx
git add packages/web/src/live/AsksStrip.tsx packages/web/src/live/Live.css packages/web/src/routes/live.tsx packages/web/src/routes/asks-preview.tsx
git commit -m "The asks rail says why it is read-only and offers the way in (ADR 221)"
```

---

### Task 6: Two admins cannot both answer the same ask

**Files:**

- Modify: `packages/web/src/live/AsksStrip.tsx` (`busy` handling, `:38`, `:168`, `:179`, `:299-321`)
- Test: `packages/web/src/live/asks.test.ts`

**Interfaces:**

- Consumes: `AskView.state` and `askIsLoud` from `asks.ts` (already exported).

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/web/src/live/asks.test.ts
it('an ask answered by another admin stops being loud the moment their answer arrives', () => {
  const ask = {
    id: 'ask1',
    from: 'stanley',
    act: 'ask',
    body: 'enable exact_match_resume',
    ts: 1_000,
    thread: null,
    meta: { species: 'approve', tier: 'blocking' },
  } as unknown as Envelope;
  const otherAdminsAnswer = {
    id: 'a1',
    from: 'dolly',
    act: 'accept',
    body: '',
    ts: 2_000,
    thread: 'ask1',
    meta: { in_reply_to: 'ask1' },
  } as unknown as Envelope;

  const [view] = deriveAsks([ask, otherAdminsAnswer]);
  expect(view!.state).toBe('accepted');
  expect(askIsLoud(view!.state)).toBe(false);
  expect(view!.answeredBy).toBe('dolly');
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run packages/web/src/live/asks.test.ts`
Expected: PASS if `deriveAsks` already folds a third party's answer (it keys on `in_reply_to`, not on sender). **If it passes, that is the point** — the derivation is already correct and only the component is wrong. Record the result and continue.

- [ ] **Step 3: Fix the component's disabled rule**

`busy` is keyed on this browser's own in-flight send, so a second admin sees live buttons on an ask that is already answered. The buttons must follow the _ask_, not the sender. In `AskCard` and the inline quick-actions, replace every `disabled={busy}` / `disabled={busy === lead.env.id}` with:

```tsx
disabled={busy === ask.env.id || !askIsLoud(ask.state)}
```

(and `busy === lead.env.id || !askIsLoud(lead.state)` for the rail's inline pair). The existing `{askIsLoud(...) && canAnswer && …}` guards already unmount them on the next render; the `disabled` is what closes the window between the firehose delivering the other admin's answer and React committing.

- [ ] **Step 4: Run the web tests**

Run: `pnpm vitest run packages/web/src/live`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/web/src/live/AsksStrip.tsx packages/web/src/live/asks.test.ts
git add packages/web/src/live/AsksStrip.tsx packages/web/src/live/asks.test.ts
git commit -m "Answer buttons follow the ask, not the sender (ADR 221)"
```

---

### Task 7: The daemon offers this machine's identity

**Files:**

- Modify: `packages/server/src/config.ts` (beside `resolveRosterRoots`, ~`:101`)
- Modify: `packages/server/src/store/audit.ts:223`
- Modify: `packages/server/src/transport/http.ts` (beside the handoff routes, ~`:1210`)
- Test: `packages/server/src/transport/integration.test.ts`

**Interfaces:**

- Produces: `GET /teams/:slug/local-identity` → `{available: false}` or `{available: true, as: string, credential: string}`; `readLocalIdentity(team: string, env?: NodeJS.ProcessEnv): {name: string; key: string} | null`.

- [ ] **Step 1: Write the failing integration tests**

```ts
// append near the other signin-handoff tests in packages/server/src/transport/integration.test.ts
it("offers this machine's identity to a local page, and never off-machine (ADR 221)", async () => {
  const team = await post('/teams', { slug: 'dusk', creator: { name: 'nick', kind: 'human' } });
  expect(team.status).toBe(201);

  // No CLI vault entry for this team → available:false. Not an error: a fresh machine is a normal
  // state, and the rail simply offers the paste path instead.
  const none = await get('/teams/dusk/local-identity');
  expect(none.status).toBe(200);
  expect(none.json.available).toBe(false);
  expect(none.json.credential).toBeUndefined();

  // Off-machine is refused, and the refusal is counted as ADR 170's cross-device signal.
  const remote = await get('/teams/dusk/local-identity', undefined, { peer: '203.0.113.7' });
  expect(remote.status).toBe(403);
  const audit = await get('/teams/dusk/audit', team.json.human_credential);
  const miss = audit.json.audit.find((r: any) => r.action === 'signin.handoff_missed');
  expect(miss.detail.reason).toBe('off_machine');
});
```

Follow the surrounding file's helpers for `get`/`post` and for simulating a non-local peer — reuse whatever the existing `requireLocalPeer` tests do rather than inventing a mechanism.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm build && pnpm vitest run packages/server/src/transport/integration.test.ts -t 'local-identity'`
Expected: FAIL — 404, no such route.

- [ ] **Step 3: Add the vault reader**

```ts
// packages/server/src/config.ts, beside resolveRosterRoots
/**
 * This machine's CLI identity for a team, read from the global `~/.musterd/config.json` (ADR 221).
 *
 * Same file and same rationale as {@link resolveRosterRoots} directly above: reading the global
 * config keeps the daemon decoupled from the CLI package while sharing the `~/.musterd/` home the
 * db already lives in. Best-effort by construction — an absent, unreadable, or agent-keyed entry is
 * simply "no local identity", never an error, because a machine without one is an ordinary machine.
 */
export function readLocalIdentity(
  team: string,
  env: NodeJS.ProcessEnv = process.env,
): { name: string; key: string } | null {
  try {
    const cfgPath = env['MUSTERD_CONFIG'] ?? join(homedir(), '.musterd', 'config.json');
    const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      identities?: Record<string, { name?: unknown; key?: unknown }>;
    };
    const id = raw.identities?.[team];
    if (!id || typeof id.name !== 'string' || typeof id.key !== 'string') return null;
    // Only a human credential signs a human in. An agent seat authenticates with the team agent key,
    // which is a harness fact rather than a person — the same gate `musterd board` applies.
    if (!id.key.startsWith('mscr_')) return null;
    return { name: id.name, key: id.key };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add the audit actions**

In `packages/server/src/store/audit.ts`, beside `'signin.handoff_staged'` at `:223`, add `| 'signin.local_offered'` and `| 'signin.local_redeemed'`, and extend the comment block above to say what they mean.

- [ ] **Step 5: Add the route**

```ts
// packages/server/src/transport/http.ts, immediately after the signin-handoff GET
/**
 * `GET /teams/:slug/local-identity` (ADR 221) — hand a page on THIS machine the identity the CLI
 * already holds, so signing into the office costs one click and no secret ever passes through a
 * human's hands.
 *
 * No nonce, deliberately. ADR 170's nonce exists to make a CLI→browser *link* inert; when the
 * browser asks the daemon directly there is no link to make inert and nothing to expire.
 *
 * `isLocalPeer` is the whole security boundary and is load-bearing rather than decorative: this
 * route returns a member credential, so off-machine it would hand a second admin the FIRST admin's
 * identity. The refusal is counted as ADR 170's `off_machine` miss — the pre-registered signal that
 * earns the bounded-credential work this deliberately declined.
 */
if (method === 'GET' && rest === '/local-identity') {
  const team = requireTeam(ctx.db, slug);
  requireLocalPeer(ctx, req, "read this machine's sign-in identity", () =>
    appendAudit(ctx.db, team.id, {
      actor: null,
      action: 'signin.handoff_missed',
      target: null,
      result: 'deny',
      detail: { reason: 'off_machine' },
    }),
  );
  const local = readLocalIdentity(team.slug);
  if (!local) return sendJson(res, 200, { available: false });
  // The vault can name a member this team has never heard of (a stale entry, a renamed seat).
  // Confirm before offering, so the page is never handed a credential that cannot connect.
  const member = ctx.db.findMemberByName(team.id, local.name);
  if (!member) return sendJson(res, 200, { available: false });
  appendAudit(ctx.db, team.id, {
    actor: local.name,
    action: 'signin.local_offered',
    target: local.name,
    result: 'allow',
    detail: { surface: 'web-live' },
  });
  return sendJson(res, 200, { available: true, as: local.name, credential: local.key });
}
```

Import `readLocalIdentity` from `../config.js` alongside the existing `isLocalPeer, resolveRosterRoots` at `:50`. Check the actual member-lookup helper name in `ctx.db` and use it rather than `findMemberByName` if it differs.

- [ ] **Step 6: Run the tests**

Run: `pnpm build && pnpm vitest run packages/server/src/transport/integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write packages/server/src/config.ts packages/server/src/store/audit.ts packages/server/src/transport/http.ts packages/server/src/transport/integration.test.ts
git add packages/server/src/config.ts packages/server/src/store/audit.ts packages/server/src/transport/http.ts packages/server/src/transport/integration.test.ts
git commit -m "The daemon offers this machine's sign-in identity, localhost only (ADR 221)"
```

---

### Task 8: One click

**Files:**

- Modify: `packages/web/src/live/client.ts` (beside `redeemSignin`, ~`:349`)
- Modify: `packages/web/src/routes/live.tsx`
- Test: `packages/web/src/live/client.test.ts`

**Interfaces:**

- Consumes: Task 7's route, Task 5's `localIdentity` prop.
- Produces: `fetchLocalIdentity(team: string): Promise<{as: string; credential: string} | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/web/src/live/client.test.ts
it('fetchLocalIdentity returns null when this machine has no identity, and never throws', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: false }), { status: 200 })),
  );
  await expect(fetchLocalIdentity('revive')).resolves.toBeNull();
});

it('fetchLocalIdentity returns null on the off-machine refusal rather than surfacing an error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
  await expect(fetchLocalIdentity('revive')).resolves.toBeNull();
});

it('fetchLocalIdentity hands back the identity when this machine has one', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ available: true, as: 'nick', credential: 'mscr_x' }), {
        status: 200,
      }),
    ),
  );
  await expect(fetchLocalIdentity('revive')).resolves.toEqual({ as: 'nick', credential: 'mscr_x' });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/web/src/live/client.test.ts`
Expected: FAIL — `fetchLocalIdentity` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Ask the daemon whether THIS machine has a sign-in identity for the team (ADR 221). Never throws:
 * "no identity" and "you are not on this machine" are both ordinary answers that mean the same thing
 * to the rail — offer the paste path instead — and neither is worth an error banner.
 */
export async function fetchLocalIdentity(
  team: string,
): Promise<{ as: string; credential: string } | null> {
  try {
    const res = await fetch(`/teams/${encodeURIComponent(team)}/local-identity`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      available?: boolean;
      as?: string;
      credential?: string;
    };
    return json.available && json.as && json.credential
      ? { as: json.as, credential: json.credential }
      : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Probe once per team in `live.tsx`**

```ts
// Probed once per connected team, never polled: it is a fact about this machine, not a live signal.
const [localIdentity, setLocalIdentity] = useState<string | null>(null);
const localCreds = useRef<{ as: string; credential: string } | null>(null);
useEffect(() => {
  if (!cfg?.team || signedIn) return;
  let cancelled = false;
  void fetchLocalIdentity(cfg.team).then((id) => {
    if (cancelled) return;
    localCreds.current = id;
    setLocalIdentity(id?.as ?? null);
  });
  return () => {
    cancelled = true;
  };
}, [cfg?.team, signedIn]);
```

Then pass `localIdentity={localIdentity}` to `AsksStrip` and change `onSignIn` to:

```tsx
onSignIn={() => {
  const id = localCreds.current;
  if (id && cfg) signIn(cfg.team, { as: id.as, token: id.credential });
  else setAdvanced((a) => ({ ...a, open: true }));
}}
```

- [ ] **Step 5: Run tests and verify end to end**

Run: `pnpm vitest run packages/web/src/live && pnpm build`

Restart `vite preview`, open `/live?team=<slug>` as an observer, click **Sign in as nick to answer**. Expected: the button is replaced in place by Approve / Deny / Deciding, the chip flips from `watching` to `nick · <team>`, and the roster shows nick `online` (ADR 155 inc 3 firing for the first time). Screenshot before and after.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/web/src/live/client.ts packages/web/src/live/client.test.ts packages/web/src/routes/live.tsx
git add packages/web/src/live/client.ts packages/web/src/live/client.test.ts packages/web/src/routes/live.tsx
git commit -m "One-click sign-in on /live (ADR 221)"
```

---

### Task 9: `musterd live`

**Files:**

- Modify: `packages/cli/src/commands/board.ts:20-27` and `:46-107`
- Create: `packages/cli/src/commands/live.ts`
- Modify: `packages/web/src/routes/live.tsx` (redeem `#s=`), the CLI command registry, `packages/cli/src/commands/board.test.ts`

**Interfaces:**

- Consumes: `redeemSignin(team, nonce)` from `client.ts` (already exported, already used by `/board`).
- Produces: `surfaceUrl(server, team, surface: 'board' | 'live')`, `signinUrl(server, team, nonce, surface)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/commands/board.test.ts
it('signs into either surface with the same one-shot nonce (ADR 221)', () => {
  expect(signinUrl('http://h:1', 'revive', 'n1', 'board')).toBe(
    'http://h:1/board?team=revive#s=n1',
  );
  expect(signinUrl('http://h:1', 'revive', 'n1', 'live')).toBe('http://h:1/live?team=revive#s=n1');
  expect(surfaceUrl('http://h:1', 'a b', 'live')).toBe('http://h:1/live?team=a%20b');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/cli/src/commands/board.test.ts`
Expected: FAIL — `signinUrl` takes three arguments.

- [ ] **Step 3: Generalise the URL builders**

```ts
export type SigninSurface = 'board' | 'live';

/** The plain surface URL — safe to print, carries nothing. */
export function surfaceUrl(server: string, team: string, surface: SigninSurface): string {
  return `${server.replace(/\/$/, '')}/${surface}?team=${encodeURIComponent(team)}`;
}

/** Kept for the existing board call sites. */
export function boardUrl(server: string, team: string): string {
  return surfaceUrl(server, team, 'board');
}

/** The signing-in URL: the same surface, plus a one-shot nonce in the fragment. */
export function signinUrl(
  server: string,
  team: string,
  nonce: string,
  surface: SigninSurface = 'board',
): string {
  return `${surfaceUrl(server, team, surface)}#s=${encodeURIComponent(nonce)}`;
}
```

Extract the body of `boardCommand` into `signinCommand(parsed, surface)`, threading `surface` through `signinUrl` and every user-facing string (`opening the board` → `opening the office` for `live`). `boardCommand` becomes `signinCommand(parsed, 'board')`.

- [ ] **Step 4: Add the command**

```ts
// packages/cli/src/commands/live.ts
import type { Parsed } from '../args.js';
import { signinCommand } from './board.js';

/**
 * `musterd live` (ADR 221) — open the office signed in as yourself, so the asks waiting on you are
 * answerable rather than merely readable. The cold-start sibling of the in-page button: same
 * one-shot nonce, same machine-local boundary, different surface.
 */
export async function liveCommand(parsed: Parsed): Promise<number> {
  return signinCommand(parsed, 'live');
}
```

Register `live` in the command registry beside `board`, with the same `--print` / `--no-open` / `--as` / `--team` flags, and add it to the help text.

- [ ] **Step 5: Redeem `#s=` on /live**

Port the `board.tsx:215-232` block into `live.tsx`'s hydration effect, **before** the `#w=` watch-link branch (a sign-in nonce outranks a watch token; they never appear together, and if they did the human's own identity is the right answer):

```ts
const nonce = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('s');
if (urlTeam && nonce) {
  setTeam(urlTeam);
  // Strip BEFORE the redeem resolves, so a slow response cannot leave the nonce in the address bar
  // for a shoulder to read. Use replaceState on the current href — the router's own navigate puts
  // the spent nonce back (izzo's find, ADR 174 acceptance run).
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  void redeemSignin(urlTeam, nonce).then(
    (id) => signIn(urlTeam, { as: id.as, token: id.credential }),
    (e: unknown) => {
      setFormError(e instanceof Error ? e.message : String(e));
      void watch(urlTeam);
    },
  );
  return;
}
```

- [ ] **Step 6: Run everything and verify**

Run: `pnpm build && pnpm typecheck && pnpm vitest run && pnpm lint && pnpm format:check && pnpm perf:check`

Then, end to end: `node packages/cli/dist/index.js live --team <slug>` from a folder bound to your seat. Expected: the office opens, already signed in, chip reads `<you> · <team>`, and the terminal prints a fragment-free URL.

- [ ] **Step 7: Commit and open the PR**

```bash
pnpm exec prettier --write packages/cli/src/commands/board.ts packages/cli/src/commands/live.ts packages/cli/src/commands/board.test.ts packages/web/src/routes/live.tsx
git add -A packages/cli packages/web
git commit -m "musterd live — the CLI walks you into the office (ADR 221)"
git push -u origin HEAD
gh pr create --fill
gh pr merge --squash --auto --delete-branch
```

---

## Self-Review

**Spec coverage.** Shared identity → Task 2/3/4. Precedence chain → Task 4. `/broadcast` exclusion → no task needed; `/broadcast` never imports `memberIdentity`, and Task 4 touches only `live.tsx`. Presence → no task; ADR 155 inc 3 already ships it, verified in Task 8 Step 5. Rail states → Task 5. Seat chip and sign-out → Task 5. Disable-on-any-answer → Task 6. Expired credential notice → Task 4 Step 6. Daemon route → Task 7. One-click → Task 8. `musterd live` → Task 9. Audit rows → Task 7 Step 4; `signin.local_redeemed` is declared there and written in Task 8 (**gap closed**: add its `appendAudit` call to the WS claim path in Task 8 Step 4, or drop it from the union — decide at implementation time and make the ADR match).

**Type consistency.** `MemberIdentity {as, token}` is used verbatim in Tasks 2–5. The daemon route returns `{as, credential}` — deliberately the same shape `redeemSignin` already returns, so both sign-in paths converge on one adapter (`{as: id.as, token: id.credential}`), used identically in Task 8 Step 4 and Task 9 Step 5.

**Known unverified details** (confirm at implementation time rather than assuming): the member-lookup helper name on `ctx.db` in Task 7 Step 5, the non-local-peer test helper in Task 7 Step 1, and the CLI command registry's exact registration shape in Task 9 Step 4.
