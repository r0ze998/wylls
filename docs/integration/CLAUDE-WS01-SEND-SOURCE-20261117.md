# ①'s board page: choose the village a caravan leaves from (2026-11-17)

**Branch:** `claude/ws01-send-source-20261117` **on `0f843db5`** (the request-link unit's final tip, unchanged).
- `5c3d406d` is the first tip.
- The correction (the second tip) is on top of it.
- **Adopt the final tip only.**

**Adoption:**
- after `c296c41a..0f843db5`;
- take this unit's own diff `0f843db5..<this tip>`.

**Static change, NOT run:**
- no test, syntax check, import, start, HTTP, RPC, signature, send or world;
- nothing tried on a real chain.

## What was missing

- **The existing contract:** `send.mjs` `planSend` already takes `source` (a village `{p, q, site}`). It reads that village's account and refuses unless its owner is the sender's Citizen (`NotYourVillage`).
- **The gap:** the page's `sendOnce` never passed it. Every caravan left from the Citizen's **first** village, and a player with several villages could not choose.

## What it does now

| Part | Change |
|---|---|
| `coop/sources.mjs` (new, reads only) | **`sourceCandidates(reader, season, wallet)`:** the villages on the sender's Citizen (`chain.mjs` `citizenOf`: `holding`, `holdingsN`), each with its present owner as read then (`holdingNow`): `mine`, `other`, or `unverified` with the reason. If the chain or the Citizen cannot be read, the answer is `unread` with the reason, **never empty and never "no village"**. **`sourceToUse(pick, chosen)`:** with nothing chosen, `null`, which is `planSend`'s old default. A chosen village is used only from a good read, as a candidate, and not owned by someone else. Otherwise it refuses with the reason; **it never swaps in the first village**. |
| the request's send row (`coop/coop-ui.mjs`) | shown only where the send button already was: **accepted, open, destination checked, and no earlier send unknown or landed but unlinked**. Before the picker is opened: a "送り元の村を選ぶ" button, and the old behaviour. Once opened: "Citizen の最初の村（これまでどおり）" plus one button per candidate, with its owner label. Another owner's village is disabled; a village not checked is labelled "持ち主を確かめられない（送るときに確かめる）". The chosen button is marked by its style and by "（選択中）". There is also a re-read button and "この送り元で見込みを出す（署名しない）". |
| estimate | `planSend({source})`: the chosen village, its path in squares, the caravan number, the fee (the game's `CARAVAN_FEE`, unchanged) and the existing stock and shortfall text (one function, `estText`, which the confirm also uses). It is shown as **見込み** and is read again at sending. |
| `sendOnce` | passes `source` from `sourceToUse` (`null` when nothing was chosen, so the old caller path is unchanged). **After `planSend` returns, before the confirm**, it does not use the plan if any of these changed: the sender (key or wallet), the request (no longer in the view), or the choice (another read or another village). It also refuses a plan whose source is not the chosen village. The confirm now names the village's site. |
| an earlier send | `blocking(q)` is checked **before** the source, as before. An unknown earlier send is still followed, never released or resent by choosing another village. Its row now shows that send's source (from the board's `sending` record). |
| `coop/index.html` | the style of the chosen button. |

**Staleness:**
- **The choice's key** is sender | program | Season | request. Another sender, world or request is another key, so an old read, choice or estimate cannot apply.
- **Within one key:**
  - a read finishing after a newer one is dropped;
  - an estimate is dropped if the choice changed while it was read, and is shown only for the village it was made for;
  - choosing clears the estimate.
- **While a send is in progress,** choosing and re-reading are refused, and their buttons are disabled.

**Unchanged:**
- `planSend`'s checks: the source's owner, the destination, the cargo and the path;
- signing, the `sending` record, sends, re-sends, follow-up and authorization;
- the board server. No ⑮ verdict.
- **Choosing or estimating accepts, signs and sends nothing.**
- A page reload forgets the choice (back to the old default). What was sent keeps its source in the board's record.

## Correction (second tip): the parent's review of `5c3d406d`

**Do not adopt `5c3d406d` alone.**

- **The gap:** the choice's key is sender | program | Season | request **id**. After `planSend`'s reads, `sendOnce` only checked that a request with that id was still in the view, and `previewSource` did not look at the request at all.
- **The effect:** the page re-reads every 4 s. If the same request changed meanwhile, a plan made from the old request and the old answer could still reach the confirm, and an old estimate stayed on screen. Changes that matter: expired or cancelled, another destination (`to`) or generation, another need, the destination check now `unknown` or `mismatch`, another world (`ctx`), or the sender's own answer withdrawn, declined or with another offer.
- **The fix:**
  - **What is compared:** `sources.mjs` `planBasisOf(q, who)` covers only what a plan depends on: `stateNow`, `requester`, `ctx`, `to`, `need`, `destination.status`, and the sender's own `answer`, `withdrawn` and `offer`. It compares by content, so a new object with the same content is the same.
  - **Not compared:** fulfilment, arrivals, other responders, or the reason text.
  - **Send:** the content is taken before `planSend`, from the request shown when the button was pressed. After the plan is read, and before the confirm, it is compared with the re-read request. If it differs: "この計画では送らない。読み直した表示で確かめて、もう一度押してください".
  - **Earlier sends:** if the re-read shows an earlier send of this sender to this request (unknown, or landed but unlinked; `pending.mjs` `pendingSendOf`, unchanged), the page does not send and says why. The existing check before the plan stays.
  - **Preview:** the estimate carries the content it was made for. It is not stored if the request changed while it was read, and it is shown only while the shown request has the same content.
- **Normal re-reads don't block:** an unchanged re-read, a fulfilment or arrival update, or another player's answer keeps the plan usable (not compared by object identity).
- **Unchanged:** signing, authorization, re-sends, and `planSend`'s owner, cargo and path checks.

## Regression (written, NOT run): `workstreams/01-national-strategy/test/coop.send-source.test.mjs` (new)

- **The candidates** on a fake chain (`coop-chain.mjs`): two villages of the sender, one now owned by someone else, one with no account. Owner labels `mine`, `mine`, `other`, `unverified`.
- **Unread is never empty:**
  - no reader, or every read failing: `unread`;
  - one village's read failing: that village is `unverified`, the others stay;
  - a wallet with no Citizen: `unread`.
- **`sourceToUse`:** the default kept; not checked allowed (`planSend` checks); another owner, no longer a candidate, loading or unread all refused.
- **`planSend({source})`:**
  - the chosen village is the source (the path starts there; the estimate is its stock);
  - no source keeps the first village;
  - another owner's village: `NotYourVillage`; no account: `NoVillage`;
  - `BadAmount` and `BadDestination` unchanged with a source.
- **The page (pinned as text):**
  - the key;
  - the four picker functions call no post, send, sign or confirm;
  - the picker sits only before the send button;
  - the stale guards;
  - the earlier send checked first;
  - the plan check before the confirm;
  - the estimate text kept (`coop.browser.mjs` reads it);
  - the unread and lost-choice texts;
  - another owner disabled;
  - the source of an earlier send shown;
  - the chosen style and its text marker.

- **(second tip) `planBasisOf`:**
  - the same content, or another key order: equal;
  - fulfilment, arrivals, sendings, links, the reason text or another player's answer: equal;
  - state, requester, world, destination or generation, need, destination check, or the sender's withdrawal, offer or answer: different;
  - a request gone: never equal.
- **(second tip) the page:**
  - the content is taken before the plan and compared after it, before the confirm;
  - an earlier send seen on the re-read stops the send;
  - the preview carries and checks the content;
  - no object-identity comparison.

The ① browser tests (`coop.browser.mjs`, `coop.browser.nokey.mjs`) are **not run**. They click `[data-testid=send]` and read the confirm's estimate. Both are kept; the confirm only gained the site.

## Hand-over (Lane D)

**Unit:** `claude/ws01-send-source-20261117`, two commits on `0f843db5` (`5c3d406d`, then the correction). Take the final tip's diff from `0f843db5`, all `100644`:
- `workstreams/01-national-strategy/coop/sources.mjs` (A)
- `workstreams/01-national-strategy/coop/coop-ui.mjs` (M)
- `workstreams/01-national-strategy/coop/index.html` (M)
- `workstreams/01-national-strategy/test/coop.send-source.test.mjs` (A)
- `docs/integration/CLAUDE-WS01-SEND-SOURCE-20261117.md` (A)

**Not run:** anything.
