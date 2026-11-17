# ⑦ the chronicle: reading, telling unread from empty, see and report, world changes (Lane C, 2026-11-17)

**Branch:** `claude/lane-c-ws07-chronicle-flow-20261117`, from the shared aggregate at `8c7f4de1d9b03665336e0075d4a3e017fe0fa6cf` (its origin tip when read). The aggregate, the away bundle (`0a1ef116`) and every other branch are unchanged.

**Written, not run:** no test, syntax check, import, page or world.

## The real path (source at `8c7f4de1`)

- **Provider:** `controller.mjs` `refreshChronicle` (in `refresh`, every poll).
  - It reads `herald.events(cursor)` page by page from a module-level `cursor` (started `chronicleStart(headSeq)` behind the head).
  - It appends the decoded records to `FS.chronicle` (the last 400), folds `FS.life`, sets `FS.chronicleRead = {ok, code, pages, bell}`, and sets `FS.isMine`.
- **Screen:** `screens/chronicle.mjs`.
  - `chronicleState` / `readLine`: waiting, unread ("記録が空という意味ではありません"), stale, ok.
  - `chronicleRows` / `render`: lines by turn; "見る" (`goto`) for a place, "報告" (`report-open`) for a clash.
- **App:** `app.mjs`.
  - `goto` moves the map; it reads nothing.
  - `openReport` reads `heraldRef.clash(p, q, bell)`, then the keep; `verifyReport`.
  - `loadSeason` re-pins the world every season poll (`setPin`): the herald can start serving another season or world while the page stays open.

## Checked and consistent

- **Unread vs empty:** `FS.chronicle` stays `undefined` until a page is read; "unread" says it is not an empty record; "stale" says the shown lines are older. An empty record after a read says "まだ記録はありません".
- **The report's read failure** says "報告を読めませんでした（code）", never "no clash".
- **"見る"** is a map move with nothing to fail.

## Fixed here (`app.mjs`, the report action and `loadSeason` only)

| # | Defect | Fix |
|---|---|---|
| D4 | `openReport` checked only `FS.report !== rep` across `await heraldRef.clash(...)` and the keep read. A report started under one pinned world could be shown, and get its keep, after `loadSeason` had re-pinned another. A report already open stayed open across a world change | `reportWorld()` comes from `FS.pin` (cluster, program, `addresses.season`: the account `setPin` derives and checks against the herald's record; `null` before a pin, nothing made up). `openReport` keeps the world it started under; an answer that arrives under another world is dropped (`FS.report = null`), not shown as read. The keep needs the same world. `loadSeason` closes a report of another pinned world, and the report's own what-if (`FS.practice.whatif`) only |

Regression (written, not run): `permutation-gateway/test/web-frontier-ws07-chronicle-world-text.test.mjs`, a key-free text check (only `node:test`, `node:assert`, `node:fs`; it reads `app.mjs` and `controller.mjs` as text, imports neither, and does not run, trace or substitute any refused test). R1–R4 cover the world source, the order of the drop in `openReport`, the keep guard, and the close in `loadSeason`. **C1–C3** cover `refreshChronicle`: forgotten before the new start, the overtaken read's return before any write, and holdings read at draw time. Running it needs its own approval. Candidate (not run): `node --test permutation-gateway/test/web-frontier-ws07-chronicle-world-text.test.mjs`.

## Fixed in the shared file, as approved: `controller.mjs` `refreshChronicle` only (D1–D3)

The coordinator (main) approved this range on 2026-11-17: `refreshChronicle` only, no other function or module, no new route or response shape, unknown kept unknown, nothing run.

| # | Defect | Proposed fix (limited to `refreshChronicle`) |
|---|---|---|
| D1 | When the pinned world changes (same herald URL, another season or world), nothing resets the chronicle: `cursor` keeps the old world's position (a new season's smaller seqs are then never read), and `FS.chronicle` and `FS.life` keep the old world's records and show them as this world's | At the start, compute the same pinned-world key. When it differs from the key the chronicle was read under, reset `cursor = 0`, `FS.chronicle = undefined`, `FS.chronicleRead = undefined` and `FS.life = new Map()`, so the screen says "読み込んでいます" and not old lines |
| D2 | The page loop awaits `herald.events(cursor)` with no check: a switch mid-read appends the old world's pages after a reset, and `cursor = r.next` moves the new world's cursor with an old answer | After each await, stop without writing anything when the herald object or the world key changed |
| D3 | `FS.isMine` captures `FS.holdings` at refresh time: after a wallet change (`resetViewer`), the former wallet's lines stay marked "（あなた）" until the next refresh | `FS.isMine` reads `FS.holdings` when it is called |

**As implemented** (all inside `refreshChronicle`):
- **D1:**
  - `worldNow()` is the pinned world from `io.pinned()` (cluster, program, `addresses.season`; `null` before a pin, nothing made up).
  - When the herald object or that world differs from what the chronicle was read under (`FS.chronicleSource`, `FS.chronicleWorld`, recorded by this function), `cursor = 0`, `FS.chronicle = undefined`, `FS.chronicleRead = undefined` and `FS.life = undefined`. The screen then says "出来事の記録を読み込んでいます", never "まだ記録はありません".
  - This happens before the new start is set from the head. The very first read resets nothing.
- **D2:** right after each `await herald.events(cursor)`, if the herald or the world changed, the function returns before any write: no records, `life`, cursor, `chronicleRead` or `isMine`. FS stays as it was, and the next call forgets the old world by D1.
- **D3:** `FS.isMine` reads `FS.holdings` when a line is drawn.

**Unchanged:**
- normal reads under the same herald and world;
- the page loop;
- the incoming departures that follow in the same function;
- every other function and module (herald, fplay, session, seal);
- routes and response shapes;
- sending, permissions, assets and rules.

**Unverified, noted:** `app.mjs`'s moment snapshot (`momentSnapshot({life: FS.life ?? new Map(), …})`) compares the previous `life` with the next. Across a real world change, it now compares the old world's life with an empty one until the new world is read. Whether that draws a spurious moment was not checked, since that needs a page.

## Not changed

Sending, auth, assets, rules, the ABI, MCP and ④.

## Hand-over (final)

See the manifest at the end.

## Final manifest (for D; the aggregate is not changed here)

- **Base:** `8c7f4de1d9b03665336e0075d4a3e017fe0fa6cf`.
- **Branch:** `claude/lane-c-ws07-chronicle-flow-20261117`. Commits: `a11962cd` (D4, app), then this commit (D1–D3, controller), which is the final tip.
- **Four paths against the base** (mode and git blob at this commit):

| Status | Mode | Blob | Path |
|---|---|---|---|
| M | 100644 | `7b787e1024b12494e2133606fd5b0e08c69c7e62` | `permutation-server/web/frontier/app.mjs` |
| M | 100644 | `06cc0820e143ce8867df4a87a8c82b3f4c33048d` | `permutation-server/web/frontier/controller.mjs` |
| A | 100644 | `5d2c319e4e61c72774d1125be679021c7159d3b6` | `permutation-gateway/test/web-frontier-ws07-chronicle-world-text.test.mjs` |
| A | 100644 | (this file) | `docs/integration/CLAUDE-LANE-C-WS07-CHRONICLE-FLOW-20261117.md` |

- **Likely conflict points:** `app.mjs` near `openReport` and `loadSeason` (the away bundle adds `awayWorld` near `awayPump`); `controller.mjs` `refreshChronicle` only.
- **Not run or verified:** every test; the page (chronicle card, report, see); a real world change; the moment snapshot across a change.
- **Candidate (independent, key-free; needs its own approval):** `node --test permutation-gateway/test/web-frontier-ws07-chronicle-world-text.test.mjs`.
