# ⑦ the way back: reading, telling failures, saving the seen mark, resuming (Lane C, 2026-11-17)

**Branch:** `claude/lane-c-ws07-away-return-flow-20261117`, from the shared aggregate at `2ff95beb9e7bb7f3b72b2bf210f1c08f23cc56cb` (fixed base; it includes ⑦'s earlier arrival bundle and ④). The aggregate and every other branch are unchanged.

**Written, not run:** no test, syntax check, import, page or world.

## The real path (source at `2ff95beb`)

`permutation-server/web/frontier/app.mjs`:
- `awayPump` builds the scope with `awayScope`, the mark with `loadMarks`, and the start point (the mark, or `AWAY_REACH` behind the head).
- It calls `hud/awayread.mjs` `createAwayReader().start` / `.more`: pages of `/h/events?after=`, with `complete`, `failed`, `bad` and `stale`.
- Then `hud/returnsum.mjs` `summarize` (mode, gap, window, items, the `confirm` range), and the head notice via `hud/returnwords.mjs` (`headText` + `confirmText`).
- The `away-seen` action calls `returnsum.confirm` (saving the mark), then `confirmedText` or dismiss.
- The next look reads from the saved mark.

## Defects found and fixed

| # | Where | Before | After |
|---|---|---|---|
| A1 | `returnwords.headText`, `confirmText` | With 0 records in range, "新しい記録はありません。" even when the reading **failed**, was **unfinished** or had a **gap**, followed by "読めた分だけを出しています" when nothing was read. `confirmText` said "新しく確認する記録はありません" after such a reading | Known-empty only for a whole reading. Otherwise: "新しい記録があるかどうかは、まだわかりません。", with "記録の読み込みに失敗しました。" or "記録はまだ続きがあります。" (no "読めた分だけ"), and "まだ記録を読めていないため、確認の位置は進めません". Readings that read something are unchanged |
| A2 | `returnsum.confirm` | The mark and the auxiliary `ws07-return:last` were written in one `try`: if only the auxiliary write threw, the result was `null`, and the page said "保存できませんでした。次に開いたときも同じ範囲が出ます" although the mark had moved | The mark is written, then **read back**; that alone decides. The auxiliary is written after it and apart; its failure gives `{marks, moved: true, lastSaved: false}`, and `confirmedText` adds "（この端末で最後に使ったウォレットの記録だけは保存できませんでした）". A write that threw but reached the store counts by the read-back. Another tab further on in between gives `moved: false` ("すでに…確認済みです"), except when replacing a mark beyond the head (that stays a failure) |
| A3 | `awayread` → `summarize` → `headText`; `app.mjs` | Undecodable bodies were counted by the reader (`bad`), but the app dropped the count: the summary never said some records could not be read, and a reading with only such records showed no notice | `summarize` carries `bad`; `headText` says "読めない記録が N 件ありました。その中身は推測しません。"; the app passes `r.bad` and shows a summary that has only bad records. How far the mark may move is unchanged |
| A4 | `loadMarks`, `confirm`, `loadLast`, `summarize`; `app.mjs` | The mark key `ws07-return:{season}:{wallet}` names no world. Another world with the same season number and wallet read from a foreign mark and could **skip that world's unread records** | New marks and the auxiliary record carry the pinned world (`FS.pin`: cluster, program, season account). A mark of another world is not used; a mark without a world (written before) reads as before. On this device, another world in "last used" is told as `newSeason` (another record). The storage key is not changed |

## Cases checked (static)

| Case | Result |
|---|---|
| Normal (marks, records, complete) | Unchanged words; confirm moves the mark and writes "last used" |
| First look on the device | `firstOnDevice` and the window, unchanged |
| Empty result, complete | "新しい記録はありません。" / "新しく確認する記録はありません" (unchanged; pinned by `screens/ws07-s1.screen.mjs:66`) |
| Failure or unfinished, nothing read | A1 |
| Failure part way, something read | Unchanged ("…件を読みました。…途中で失敗しました。読めた分だけ…"; pinned by `web-frontier-ws07-away.test.mjs:106`) |
| Reread or next look | Reads from the saved mark (`more()` from the cursor); unchanged |
| Duplicate press | `moved: false`, harmless (unchanged); another tab ahead → `moved: false` (A2) |
| Main save fails | `null`, the notice stays (unchanged; `away.test.mjs:268-276` throwing and dropping stores still give `null`) |
| Only the auxiliary save fails | A2 |
| Another wallet, another season | Unchanged (`otherWallet`, `newSeason`; marks keyed by wallet and season) |
| Another world | A4 |
| A late answer of an old scope | `awayread` marks it `stale` (generation counter) and it carries no records; the app also checks `r.scope !== awayScopeNow()`. Unchanged |

The scope boundary is kept, and the mark only ever covers what was read: `confirm` is still `{ok: false, why: 'gap'}` across a gap, and `partial` stops at the last record read.

## Limitations (not changed; decisions)

- **Another world with the same key:** confirming in world B now replaces world A's mark (before, B silently used A's). World A then reads from a first look, which never skips unread records but loses A's position. Keeping both needs a per-world storage key, which is a storage decision.
- **Undecodable records:** they are told, but the mark may still move past them, as before. Holding the mark at one would stop a permanently malformed record from ever being confirmed past, which is a rule decision.
- `workstreams/07-player-experience/src/return-summary.mjs` (prototype only) is unchanged.

## Changes

- **Code:** `hud/returnsum.mjs`, `hud/returnwords.mjs`, `app.mjs` (the away path only: `awayWorld`, the `loadMarks`/`summarize`/`confirm` calls, the notice condition) and `lang/en-frontier-play.mjs` (six new keys).
- **Contract:** `workstreams/07-player-experience/CONTRACTS.ja.md` has a new section on the away summary (A1–A4 and the limits).
- **Existing expectations:** none needed correcting. Every pinned text is a whole reading or a both-writes-fine save, and those are unchanged.
- **Not changed:** sending, auth, assets, rules, the ABI, P1, MCP and ④.

## Regression (written, not run) and the pre-run audit

| Test | What | Static closure | Verdict |
|---|---|---|---|
| `permutation-gateway/test/web-frontier-ws07-away-return.test.mjs` (new) | Real functions: A1 (whole, failed, unfinished, gap, partial), A3, A2 (aux only, main, dropping, late throw, both fine, double, other tab, reset), A4 (world, legacy, last, mode), a late answer of an old scope, English | 30 files; no key API, `child_process`, `worker_threads`, dynamic `import()`, write or network | **Held**: it loads `lang.mjs` and `fi18n.mjs` (refused subjects); the coordinator decides |
| `permutation-gateway/test/web-frontier-ws07-away-return-text.test.mjs` (new) | T1–T5: the same changes, as source text | Itself only (`node:test`, `node:assert`, `node:fs`; it reads four files) | **The only independent, key-free candidate**: `node --test permutation-gateway/test/web-frontier-ws07-away-return-text.test.mjs` |
| `test/web-frontier-ws07-away.test.mjs` (existing) | — | Listed in `node-key-tests.txt` | Held (manual key job only) |
| `screens/ws07-s1.screen.mjs` | — | Browser | Not run |

## Hand-over to D (the aggregate is not changed here)

- **Base:** `2ff95beb9e7bb7f3b72b2bf210f1c08f23cc56cb`.
- **Branch:** `claude/lane-c-ws07-away-return-flow-20261117` (the tip is given in the session report).
- **Eight paths:**
  - `permutation-server/web/frontier/hud/returnsum.mjs` (M);
  - `permutation-server/web/frontier/hud/returnwords.mjs` (M);
  - `permutation-server/web/frontier/app.mjs` (M, away path only);
  - `permutation-server/web/lang/en-frontier-play.mjs` (M);
  - `workstreams/07-player-experience/CONTRACTS.ja.md` (M);
  - `permutation-gateway/test/web-frontier-ws07-away-return.test.mjs` (A);
  - `permutation-gateway/test/web-frontier-ws07-away-return-text.test.mjs` (A);
  - this report (A).
- **Likely conflict points:**
  - `app.mjs` (shared, large): the edits sit in `awayScopeNow`'s neighbourhood, `awayPump` and the `away-seen` action;
  - the away keys in `en-frontier-play.mjs`;
  - the end of `CONTRACTS.ja.md`.
- **Not verified:** any run, the real away notice on a page, real storage failures.
