# Village orders: "sent, outcome not known" is shown as that, in the turn list and the status toast (2026-11-17)

**Branch:** `claude/ws07-order-unconfirmed-display-20261117`, one commit **on `e3de2695`**: the fixed order-scope unit (`claude/ws07-order-scope-20261117`), which is unchanged. Adopt it after that unit.

**Static change, NOT run:**
- no test, syntax check, import, CLI, send, signature or world;
- every edit is a plain text replacement.
- Nothing here is "verified": the regression below is written, not run.

## The defects (found by the parent; traced here to every consumer)

**The record:** since `e3de2695`, a sent order with an unknown outcome is recorded `state: 'unconfirmed'` (controller `orderUnconfirmed`), as local play already did.

**What the screen made of it:**

| Consumer | Before | Now |
|---|---|---|
| **`hud/turnlist.mjs` `turnModel`** | every state but `refused` went to `orderText`, the **done** sentence. An unconfirmed train read "…を訓練しました"; a build "…を建設中（完成）". | **its own row:** "<what> — 送信しました。確定はまだ確認できていません。署名 <first 12 characters>". `why` is the code's own text (`clientText`: `Unconfirmed`, `TxUnqueryable`, `LocalActUnconfirmed`). The row is marked `unconfirmed` (class `unconfirmed`), not `refused`. |
| **`hud/status.mjs` `statusOf`** (the map's toast) | every notice that is not busy, waiting or ok was a **refusal**: "できませんでした", plus what a refused action left undone ("訓練はまだされていません。"), as an alert. That covered the ordinary path's unknown (`failed(t)`, code `Unconfirmed` or `TxUnqueryable` with `state` `unknown` or `unqueryable`) and local play's unconfirmed notice. | **its own state `unconfirmed`**: the notice's own text (local play's line with the signature, or the code's text), `role="status"`, no "できませんでした" and no "not done" line. Close as before. |
| **`hud/hand.mjs`** | counts this turn's orders (`model.orders`) of every state | unchanged: the order was given |

**How the notices are recognised (`unconfirmedNotice`):**
- **Ordinary path:** `tx.track`'s own answer (fplay.mjs). `unknown` gives `Unconfirmed` and `unqueryable` gives `TxUnqueryable`, and `failed(t)` keeps both `code` and `state`. A refusal before sending has no `state`, so it is still a refusal.
- **Local play:** its two order notices now carry `code: 'LocalActUnconfirmed'` (`controller.mjs` `localActAsk` and `actOnce`: one key added to each `setNotice`).
- **Not changed:** the march send's own notice line (pinned verbatim in `web-frontier-local-play-march-send.test.mjs`). A local notice without the code shows as before, a refusal toast.

**No new wording:**
- the turn-list sentence is an existing key (`en-frontier-hand.mjs`: "Sent. Not confirmed yet. Signature {0}"), and the toast uses the codes' existing texts;
- no English is added, and nothing says that resending is safe.

## Not changed (rules for the owner)

**The retry button ("もう一度") on an unconfirmed toast is offered exactly as before** (`canRetry && notice.retry !== false`).
- `notice-retry` re-runs the last control, which on the ordinary path sends a **new** transaction for an order that may already have landed.
- Hiding it, or making it ask the status first (as local play's held ledger does), changes the retry contract. **That is the owner's decision. Not done here.**

**Also unchanged:**
- the re-press of an unconfirmed order on the ordinary path (it sends again);
- `sendKey`;
- every send, signature, permission and authentication rule;
- local play's rules.

## Regression (written, NOT run): `permutation-gateway/test/web-frontier-order-unconfirmed-display.test.mjs`

The pure modules over a hand-made store, as the existing status tests import them.

**Turn list:**
- an unconfirmed train and build say "sent, not confirmed" with the signature (12 characters), never "訓練しました", "建設中" or "完成";
- accepted and refused rows read as before.

**Status:**
- `Unconfirmed`/`unknown` and `TxUnqueryable`/`unqueryable` give `unconfirmed`, with no "not done" line, `role="status"` and no "できませんでした";
- the retry follows `canRetry` as before;
- local play's coded notice gives `unconfirmed`;
- a refusal before sending, a chain failure, and `Unconfirmed` without a `state` are still refusals;
- busy, done and waiting are untouched.

**Controller:** the two coded local notices, and the march line left verbatim.

## Counter-review (static, once)

- **Pins:**
  - `web-frontier-local-play-act.test.mjs` pins `…orderUnconfirmed\(order, r\.signature\);` (the text before the `setNotice`), which is unchanged;
  - the march line is unchanged;
  - no test reads `turnModel` or `statusOf` for an unconfirmed order or notice (`git grep`);
  - `web-frontier-delegation.test.mjs`'s refusal toasts keep their codes, so they are still refusals.
- **Dictionary:** one merged dictionary (`lang.mjs` `EN`), so the reused key resolves in `turnlist`.
- **Lanes not touched:**
  - Lane C's app, report, battle, people, fx, stage and sheetfx;
  - Lane D's ③⑤⑥⑧ and bots.
- **No overlap with Lane C:** the files here (`controller.mjs`, `hud/turnlist.mjs`, `hud/status.mjs`) are not in Lane C's open report-play unit (`e37bf5fc`: `app.mjs`, `screens/report.mjs`, `lang/en-frontier-play.mjs`, …).

## Hand-over (Lane D)

**Unit:** `claude/ws07-order-unconfirmed-display-20261117`, one commit on `e3de2695`, all `100644`:
- `permutation-server/web/frontier/hud/turnlist.mjs` (M)
- `permutation-server/web/frontier/hud/status.mjs` (M)
- `permutation-server/web/frontier/controller.mjs` (M: two notice lines)
- `permutation-gateway/test/web-frontier-order-unconfirmed-display.test.mjs` (A)
- `docs/integration/CLAUDE-WS07-ORDER-UNCONFIRMED-DISPLAY-20261117.md` (A)

**Depends on** `e3de2695`.

**Not run:** anything.
