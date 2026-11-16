# Lane D — play-screen English audit (rounds 33–49 and the land preview), 2026-11-16

Branch `claude/lane-d-english-audit-20261116`, cut from `claude/continuous-territory-integ-20261115` at 7fc09e28.
Read-only on the dictionaries and the pages: this lane changes no English. Each entry found wrong is listed
below with the current English, the proposed English and the reason; the dictionary owner decides.

## What was audited

- The entries added or changed in canonical rounds 33–49:
  `git log 427c4963^..68e8548d -- permutation-server/web/lang` (427c4963, 8e385098, 3a85aa9c, 37a3019a,
  2721acd3, 701a7608, 7cf55a04, de18bf02), in `lang/en-frontier.mjs`, `en-frontier-play.mjs`, `en-frontier-hand.mjs`.
- The land preview's entries: `git diff 68e8548d 7fc09e28 -- permutation-server/web/lang
  permutation-server/web/frontier/land.mjs permutation-server/web/frontier/map/landmarks.mjs` (10 keys in
  `en-frontier-play.mjs`, used by `frontier/land.mjs`; `landmarks.mjs` adds no Japanese text).

The full list of keys checked (108) is the `KEYS` table of
`permutation-gateway/test/web-lang-play-glossary.test.mjs`, by dictionary and round.

**Left out on purpose**

- The expedition return's lines in `frontier/fexpedition-return.mjs` (completeness (b)/(c) of
  `web-lang.test.mjs`; an owner's open design call): 出発元の結果を受け取るのを待っています…,
  出発元で失われた軍勢の結果の受け取りと後処理の確認が必要です…, 到着先の解決と結果の受け取りの証拠が必要です….
- The resident lines: このウォレットは、この世界の住民と村にまだ結び付いていません。 and
  このウォレットは、この世界の記録にある結び付きと合いません。
- No NFT, prize or session strings are in the range.

## The rules checked (and where they come from)

| Rule | Source |
|---|---|
| The key is in the dictionary named; the same English in every dictionary that has it; the merged `EN` shows that English | "one English per Japanese key" (round 36, 3a85aa9c; `web-lang.test.mjs` "dictionaries") |
| No Japanese, straight apostrophes, placeholders kept | `GLOSSARY.md` Style; `web-lang.test.mjs` "dictionaries" |
| None of: bell, tick, settle/settled/settlement, keeper, beacon, seed, secret, site ticket, lamport | `web-frontier-cards.test.mjs` / `frontier-local-play-pair-guide.test.mjs` `BANNED_EN`; `web-lang.test.mjs` time-step guard; `GLOSSARY.md` The Frontier (キーパー, ビーコン, 乱数, 精算) |
| British spelling | `GLOSSARY.md` Style, "Exception, the Frontier client" |
| The glossary's word for each game term: ターン turn, 軍勢 host, 進軍 march, 封 seal, 州 province, マス tile, 村 village, 国 nation, 包囲 siege, 都市 city, 決着 resolved, 結果を受け取る collect, 世界の進行役 automatic services, 領土の試験 territory trial, 土地 land, and the client's own: ローカルプレイ local play, テスト用ウォレット test wallet, 記録の配信元 records server, 端末 device, 署名 sign | `GLOSSARY.md` The Frontier; the client's existing entries |
| 「X」 → “X” (a tab's name may go without quotes), 〜 → – | `GLOSSARY.md` Style |
| The English claims nothing the Japanese does not | read by hand, entry by entry |

## Result

- 108 keys checked; 97 ok as they are (one with a note, below); 11 proposed changes (D-1 … D-11).
- `node --test test/web-lang-play-glossary.test.mjs`: 5 pass, 0 fail, 11 todo (one todo per proposal; each
  asserts the proposed English, so it passes once the dictionary takes it — then turn it into a plain test).
- Base, alone: `node --test test/web-lang.test.mjs`: 22 pass, 2 fail — the known completeness (b)/(c) failures
  (fexpedition-return.mjs: 18 unmarked lines; 17 en-frontier*.mjs entries no page uses). Not touched.

### ok with a note

- **ok-1** 見込み（今出発し、軍勢が残り、ほかの戦いがない場合）：… → "Estimate if it sets out now, survives and meets no
  other fight: …". 軍勢 is "it" (the card's own host); the line sits on that host's card, so this is not a missing term.
- 預けた資源：…返却先の拠点がもうありません… → "The holding it came from…": the Japanese itself still says 拠点 (the
  word before 村 / village, W11); the English is faithful. If the Japanese moves to 村, the English becomes "village".
- 結果は、探索したターンの決着のあとに出ます。 → "… is resolved. " ends with a space (as before round 38): it is
  joined to a following sentence, not a typo.
- 照合 is "check" in this client (結果を照合する / "Check the result" and its siblings); only the clash report's
  照合しています… is "Verifying…" (round 36's decision). 署名前の内容を照合しました / "were checked" and
  その軍勢のカードで結果を照合してください / "Check its result" follow that.
- あなたの包囲が進行中です：… (not in the range) has the same "declared at turn" as D-9; take both together.

## Proposed changes

| Id | Dictionary | Key | Current English | Proposed English | Reason |
|---|---|---|---|---|---|
| D-1 | en-frontier.mjs | 道の州の指定が正しくありません（1〜4 州）。 | The route's provinces are not valid (1 to 4 provinces). | The route's provinces are not valid (1–4 provinces). | 〜 → – (`GLOSSARY.md` Style); every sibling range uses – (0.0001–6, 100–30,000, turns {0}–{1}). |
| D-2 | en-frontier.mjs | テスト用ウォレットは、この端末で開いたページでしか使えません。 | The test wallet works only on a page opened on this computer. | The test wallet works only on a page opened on this device. | 端末 is "device" in every other entry (this device's clock, kept on this device, this device opens the seal). |
| D-3 | en-frontier-hand.mjs | 戻るのは包囲の結果を受け取ったときで、それまでは「返却待ち」と表示します。 | They come back when the siege's result is collected; until then they are shown as waiting. | They come back when the siege's result is collected; until then they are shown as “waiting to be returned”. | 「X」 → “X”; the Japanese names the label the deposit line shows ("Deposit: waiting to be returned"), the English drops it. |
| D-4 | en-frontier-play.mjs | 世界は同時に2つまでです。どの世界も、開始サービスで決めた時間（既定は開始から2時間）がたつと…（勝手には止めません）。 | … (two hours from its start unless the operator chose another) … | … (two hours from its start by default) … (rest unchanged) | 既定 is "by default", as the two sibling entries say; the Japanese names no operator and no choice. |
| D-5 | en-frontier-play.mjs | 領土の試験（テスト用の世界）：この村の州で軍勢が立って広げたマスと、その分の生産の上乗せです。 | Territory trial (test world): the tiles your nation's hosts claimed by standing in this village's province, and the production they add. | Territory trial (test world): the tiles hosts claimed by standing in this village's province, and the production they add. | The Japanese does not say whose hosts. The count is the viewer's nation's (`land.mjs` landSummary), so the alternative is to add あなたの国の to the Japanese and keep the English: the owner's call. |
| D-6 | en-frontier.mjs | テスト用ウォレットは、ローカルプレイを選んだときだけ使えます。 | The test wallet is used only when local play is chosen. | The test wallet can be used only when local play is chosen. | 使えます is "can be used"; "is used" says the wallet is in use whenever local play is chosen. |
| D-7 | en-frontier.mjs | 軍勢はターン {0} に到着 · 位置を読み込んでいます | Its host arrived on turn {0} · reading where it stands | Host arrived on turn {0} · loading its position | The Japanese has no "Its" (whose host is the tag's place, not said); 読み込んでいます is "loading". Low. |
| D-8 | en-frontier-hand.mjs | いまは納めるものがありません（命令のたびに蔵は納められます）。蔵は毎時 +{0} 増えています | Nothing to store now (every order writes the harvest into the stores). They are growing by +{0} an hour | Nothing to store now (every order stores it). The stores are growing by +{0} an hour | "harvest" is not in the Japanese; 蔵 is the subject of the second sentence ("They" could read as the orders). Low. |
| D-9 | en-frontier-hand.mjs | あなたの包囲は必要なターンを満たし、占領の結果を受け取るのを待っています（ターン {0} 以降・宣言はターン {1}・場所 {2}）。… | … (due from turn {0}; declared at turn {1}; site {2}) … | … (from turn {0}; declared on turn {1}; site {2}) … (rest unchanged) | In a sentence "on turn N" (`GLOSSARY.md` ターン); 以降 is "from", "due" adds a claim. Take the sibling あなたの包囲が進行中です… with it. Low. |
| D-10 | en-frontier-hand.mjs | 今回の記録のスロット | Slot of this reading | Record slot of this check | 記録のスロット is "Record slot" (round 36, 3a85aa9c); "reading" is no other entry's word for 記録. Low. |
| D-11 | en-frontier-play.mjs | この州で獲得 {0} マス · 生産 +{1}% | Claimed here: {0} tile(s) · production +{1}% | Claimed in this province: {0} tile(s) · production +{1}% | この州 is "this province"; on the village strip "here" does not say which place. If the strip is too tight, the owner may keep "here" (then mark the entry ok). |

## Files

- `permutation-gateway/test/web-lang-play-glossary.test.mjs` (new; the only test this lane adds)
- this note

No dictionary, page or other test file was changed in round 1 (round 2 below changes two dictionary lines).

## Round 2 — candidate `claude/canonical-candidate-20261116` at aa12ce74 (2026-11-16)

Branch `claude/lane-d-english-r2-20261116`, cut from aa12ce74. D-1 … D-11 were already taken on integration and
are ordinary tests there; not reapplied. Scope: every Japanese play-screen text added or changed in
`permutation-server/web/frontier` and `web/lang/en-frontier*.mjs` between 7fc09e28 and aa12ce74.

**Checked (14 new keys, added to the test's `KEYS`):** ほかの州 {0} マス, （毎時 +{0}）,
地図で読み込んだほかの州だけを数えます…, the fort and garrison checks (この要塞にはあと {0} 人まで入れられます,
要塞を選んでください, 入れる人数が範囲の外です, この要塞には、それだけ入る空きがありません, 入れる人数は 1 から {0} までです,
守備隊にはあと {0} 人まで入れられます, 増やす人数は 1 以上の整数です, 守備隊には、それだけ入る空きがありません),
この村はもう追放されています…, 城壁の工事は 2 つ先までです…, and the scout muster line 訓練した斥候を一つの隊にまとめましょう…
(整列 is "stands" / "form up", as in every formingLine entry). New glossary terms in the test: 要塞 fort, 守備隊 garrison,
追放 expel.

**ok with a note**

- **ok-2** この村はもう追放されています（国に戻す提案は…） → "a proposal to readmit it": 国 is not said, but "readmit"
  is 国に戻す. Left as it is.
- （毎時 +{0}） → " (+{0}/h)": the chip's tight form; full sentences say "+{0} per hour". ok.

**Fixed (dictionary, this branch)**

| Id | Dictionary | Key | Was | Now | Why |
|---|---|---|---|---|---|
| R2-1 | en-frontier-play.mjs | 地図で読み込んだほかの州だけを数えます（テスト用の世界）。地図を動かすと変わることがあります。 | Land claimed in the other provinces the map has loaded only (test world). It can change as you move the map. | Counts only the other provinces the map has loaded (test world). It can change as you move the map. | The Japanese says what is counted (only the other provinces loaded), not "land claimed"; "only" was misplaced. The tooltip sits on Lane C's land chip (`frontier/land.mjs`); the page is untouched. |
| R2-2 | en-frontier-play.mjs | 反映の目安まで（ゲーム内） | Estimated wait (game time) | (removed) | No page uses the key since onboarding.mjs moved to the shared formingLine (completeness (c) of web-lang.test.mjs failed on it). |

**Reported, not touched**

- `permutation-server/web/lang/en-frontier-play.mjs.orig` (1,569 lines) is committed in the candidate. It came in with
  bcc63a24 (the Codex WIP checkpoint), so it isn't this lane's file. It isn't a registered dictionary, but it sits
  next to them: the owner should delete it.
- The expedition return's lines are now marked in `hud/returncard.mjs` and have English in `en-frontier-hand.mjs`.
  Their meaning is still an owner's open design call, and "Residence in the wide region" (滞在) sits next to resident
  wording, so they weren't audited.

**Tests (alone, pure: they import web/lang.mjs, i18n.mjs and state.mjs and read files only):**
`node --test test/web-lang-play-glossary.test.mjs` 18 pass / 0 fail; `node --test test/web-lang.test.mjs`
24 pass / 0 fail (it was 23 / 1 on aa12ce74, the 1 being R2-2).

## Round 3 — candidate at d5b8e382 (2026-11-16)

Branch `claude/lane-d-english-r3-20261116`, cut from d5b8e382 (R2 already in; not reapplied). Since aa12ce74 only
`frontier/app.mjs` (no new text) and the R2 dictionary lines changed, so this round read the reachable refusal and status
texts in full: `fi18n.mjs` ERROR_TEXT (every program refusal, 107 lines) and CLIENT_TEXT (the page's and the relay's
refusals, statuses and cancellations, 232 lines), each Japanese against its English. Every one has English (0 missing).
Left out: Resident* / NFT, prize, payment and faucet lines (restricted lanes).

**Fixed (en-frontier.mjs)**

| Code | Japanese | Was | Now | Why |
|---|---|---|---|---|
| CapturePending | 占領処理中です。結果が確定してから操作してください | Capture is being settled. Wait for the result before acting. | The capture is being processed. Act once its result is confirmed. | "settled" is banned on the play screen. The line can be seen as the locked source option of the fort march (s1.mjs). |
| RaidState | この隊商には決着を待つ略奪がない、またはすでに決着しています | There is no open raid on this caravan, or it is already settled. | There is no raid on this caravan waiting to be resolved, or it is already resolved. | 決着 is "resolved"; "settled" is banned. |
| StakeUnsettled | 包囲の結果をまだ受け取っていません | The siege result has not been received yet. | The siege's result has not been collected yet. | 結果を受け取る is "collect the result" (glossary): the player has to act. |
| SiegeBusy | この軍勢は包囲に参加中です | This host is already besieging a village. | This host is already taking part in a siege. | The Japanese says the host is in a siege; sieges are of cities, not villages. |
| HoldingsFull | 保有できる村の上限に達しています | You have reached your holding limit. | You already hold as many villages as you can. | 村 is "village" (W11); "holding" is the old word. |
| NotBesiegeable | この村は現在包囲できません | This holding cannot be besieged now. | This village cannot be besieged now. | Same. |
| FrontierProtected | この村は辺境の保護期間中です | This holding has frontier protection. | This village is in its frontier protection period. | Same; 期間 (a period) was dropped. |
| VaultSite, StructureSite | …（通れない土地、村、砦、野営地、または既存の…） | (impassable, a site, the keep, …) | (impassable, a village, the keep, …) | 村 is "village"; "a site" says something else (a place a village could go). |
| BadWorldMode | この記録の世界設定と版を確認できません… | This record’s … | This record's … | Straight apostrophes (GLOSSARY.md Style). |

**Proposed, not changed**

- **R3-P1** HostInTransit 「この軍勢は、進軍の結果を受け取るまで動かせません」 → "This host cannot move until its
  march is resolved." The Japanese says the player has to collect the march's result first. The English sounds like
  waiting will do. Proposed: "This host cannot move until its march's result is collected." Not changed here, because
  `web-frontier-errors.test.mjs:87` and `web-frontier-relay.test.mjs:365` pin the current English, and editing those
  tests is outside this lane. `test.todo` in `web-lang-play-refusals.test.mjs`.

**Read and left as it is**

- 捕捉記録 → "captured record" (WideReadOnly and five other wide-view entries, and the wide mode's code). It's one term
  used the same way throughout, but in a conquest game "captured" can read as a captured village. If the owner wants a
  change, it should be one term-wide change ("snapshot record"), not one line.
- 取消の前に成立した分は、まだ受け取っていません → "…has not been received yet" (an order cancelled in part). It's the
  economy display (Lane C's area) and not 結果を受け取る, so I left it.

**Tests (each alone; pure: the new one imports only fi18n.mjs and lang.mjs, whose imports are local tables with no
DOM, network or storage):**
`web-lang-play-refusals.test.mjs` (new) 3 pass / 0 fail / 1 todo; `web-lang-play-glossary.test.mjs` 18 / 0;
`web-lang.test.mjs` 24 / 0. Not run: `web-frontier-errors.test.mjs` and `web-frontier-relay.test.mjs` (the relay one
reads the relay's sources). A static grep finds no test that pins any English changed here.
