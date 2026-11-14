# NFT 参加パス：NFT 住民の操作の対応表と、公開前の工程の監査（2026-11-14）

branch `claude/nft-pass-mint-20261114`。source を読んで整理した監査と、そこから直した軽い実装の記録。world・validator・host build は使っていない（領土側の build と world の実行中）。商用の条件（価格・供給数・ロイヤリティ・treasury・authority・配備先）は決めていない。

**区分の約束**（混同しない）：
- **A. NFT lane（`localnet-nft-sbf`）で ResidentAct が包める S1 の player 命令**：この文書の対象。
- **B. wide の領土戦（拡張・征服）との統合**：別。今の playable lane（`0x4804`）は NFT と同時に build できず、版の割り当ては workstream 4 の決定事項（`CLAUDE-NFT-PASS-LOCAL-WORLD-20261114.md` §1）。ここでは扱わない。
- **C. 公開 production 対応**：別。NFT lane は試験専用（program ID 固定、`deployable no`）。本番の program・版・配備は未決（§3）。

## 1. NFT 住民の操作（A の範囲）

### 1.1 program と relay

`permutation-frontier/src/proc/resident.rs` `act` が包む内側の命令は 26（`frontier_abi::resident_wire` の一覧と一致）：Harvest・Build・Train・Explore・Muster・Dissolve・Garrison・Depart・BuildStructure・SeizeStructure・CloseStructure・FortGarrison・Propose・Vote・BuildVault・SendCaravan・RaidCaravan・RaidDomestic・SeizeVault・CloseVault・SetVigil・FileOutpost・FileTicket・PlaceHome・DeclareSiege・RetireHost。

- **仕様で非対応**：SetSession（NFT Citizen の session は住民 program のもの。`Auth` で拒否）。一覧にない命令はすべて `BadData`（Join・CreateSeason などの operator・keeper の命令、Reveal のような witness の命令は NFT の player の命令ではない）。
- 世代と持ち主：どの命令も同じ取引の中で、Core asset の今の持ち主（または持ち主が今の世代で設定した session）・transfer guard・署名した世代を照合する（`resident_auth`）。譲渡で世代が上がるので、譲渡前の署名・旧持ち主・旧持ち主の session はすべて拒否。
- relay：26 命令はすべて `relay_player_shape: true`。relay は ResidentAct を内側の player shape として検査し、holder gate が chain を読んで先に拒否する（`resident-chain-gate.mjs`）。

### 1.2 ゲーム画面の経路

| 命令 | 画面の経路 | 状態 |
|---|---|---|
| Harvest | `act()`（ResidentAct で包む、送信前に世代を読み直す） | **通常 world で確認済み**：B が画面から Harvest、chain の蔵が増えた（LOCAL-WORLD §5f） |
| PlaceHome | `act()`（NFT は鍵の手順を飛ばす） | **通常 world で確認済み**（A の最初の村） |
| JoinResident | `nft-login` | **通常 world で確認済み** |
| SetVigil | `act()` | **実 chain（fixture world）で確認済み**（B が A の Citizen を変更、§4.1） |
| Build・Train・Muster | `act()`（命令名で直接） | **通常 world で確認済み（取引で照合）**：B の署名の ResidentAct（世代 1）→ Build・Train・Muster、成功、事象 BUILD・TRAIN・MUSTER（LOCAL-WORLD §5g） |
| Explore・Dissolve・Garrison・FortGarrison・Propose・Vote・SendCaravan・RaidCaravan・FileOutpost・FileTicket・DeclareSiege | `act()`（命令名で直接） | 配線済み・**通常 world で未確認** |
| BuildStructure・BuildVault・SeizeStructure・SeizeVault | `act()`（命令名を変数で） | 配線済み・**未確認** |
| **Depart（行軍）** | `fmarch.sendMarchRetrying` → **これまで Frontier の session 鍵で署名**していた。NFT Citizen には session 鍵が無いので行軍できなかった | **今回直した**：`fresident.marchSubmitFor` で、NFT を遊ぶときは持ち主の wallet が ResidentAct の中で署名する（世代を読み直す。パスが無ければ署名前に `NftNotHeld`）。`web-frontier-nft-march.test.mjs` 4/4。**通常 world で確認済み（取引で照合）**：B の署名の ResidentAct（世代 1）→ Depart、成功、事象 DEPART（LOCAL-WORLD §5g） |
| 行軍の Reveal | relay の `/f/reveal` と keeper（player の署名ではない） | **通常 world で確認済み（取引で照合）**：同じ host の REVEAL（画面で選んだ行き先のマス）、DEPARTURE_SETTLED・TRANSIT_SETTLED、署名者は B ではない（LOCAL-WORLD §5g） |
| RetireHost・CloseStructure・CloseVault・RaidDomestic | この画面には出していない | 画面の機能が無い（program は包める） |
| SetSession | 画面は NFT では求めない（`NftNoSession`） | 仕様どおり非対応 |

旧持ち主の拒否の画面表示：ページ自身の送信前の確認で `NftNotHeld`（「This resident NFT is not in this wallet now.」、通常 world で確認済み）、relay の gate の拒否文は日英あり（`web-frontier-nft-viewer-switch.test.mjs`）。

**通常 world で確かめる残り**（次の枠、領土側と調整してから）：Build（建設）・Train・Muster（部隊）・Depart（行軍）と Reveal を B が画面から行い、chain の Holding・Host・march の口座で照合する。旧持ち主 A の同じ操作が画面で拒否され、chain が変わらないこと。

## 2. 公開前の工程の監査（C の手前：既存実装で何が守られ、何が未決か）

| 工程 | 既存実装で守られていること | 未決・要判断（決めていない） |
|---|---|---|
| ウォレット接続 | Wallet Standard。接続先の chain をページの設定と照合、RPC の genesis hash が違えば何もできない。試験ウォレットは server が `testWallet` を言うときだけ | 実ウォレット（Phantom・Backpack・Solflare）と実機での試験（A10） |
| network・RPC | 発行ページの `/rpc` は**今回、ページが使う 7 method だけを転送**するようにした（open proxy にならない）。body は 64 KiB まで | RPC 提供者（A7）。`/mint/mine` は getProgramAccounts を使う：公開 RPC で使えなければ DAS か自前の索引（U28） |
| 試験用のつまみ | **`/mock/*`（airdrop・応答の握りつぶし・状態）が設定に関係なく常に開いていた → 今回 `testKnobs` 指定のときだけにした**（local の 3 起動だけが指定。既定は閉）。`mint-server-guard.test.mjs` 5/5 | — |
| config（住民 program） | `InitConfig` は program の upgrade authority だけ（配備直後の乗っ取り防止）。販売は閉じた状態で始まり、供給数・名前・URI が揃うまで開けない。価格・treasury・collection を取引ごとに照合（`PriceChanged`・`WrongTreasury`・`WrongCollection`）。authority の引き渡しは propose → accept の 2 段 | config authority の鍵と保管、多重署名にするか（U27・U29、A2）。価格・供給数・期間・1 wallet 上限（U24） |
| policy（Frontier） | `CreateResidentPolicy` は Frontier の upgrade authority だけ、一度だけ、guard は住民 program の collection-authority でなければ拒否（実 chain で確認） | 本番の Frontier program・版（B・C、workstream 4） |
| collection・metadata | collection の update authority は住民 program の PDA。NFT の名前・URI は mint 時に config から入る | **collection と発行済み NFT の名前・URI を後から変える命令が無い**（変えるには program の更新が要る）。画像・metadata の置き場、Royalties を付けるか（U30） |
| 管理・販売開始の安全 | 開始は SetTerms（authority の署名）。期間外・上限超・売り切れは program が拒否、ページは理由を表示（日英） | 誰がいつ開けるかの運用。1 wallet 上限は wallet ごとの PDA なので、複数 wallet では超えられる（仕様の限界として明記） |
| 署名・発行のエラー | 署名拒否、SOL 不足、二重クリック、応答の消失（署名で照会、再送しない）、期限切れ（asset 口座の有無で判定）、支払い後の失敗（取引ごと戻る）を模擬と実 program で試験済み | 実ウォレットでの挙動 |
| 重複 | 同じ asset の 2 回目は `AlreadyInitialized`、同一取引の再送は runtime が拒否、1 NFT・1 Citizen（world ごと） | — |
| 譲渡 | `TransferResident`（持ち主の署名）だけが asset を動かす（Permanent Freeze＋Permanent Transfer Delegate）。世代が上がり session が消える。旧持ち主は拒否（実 chain・通常 world で確認）。**発行ページに試験用の譲渡の画面を追加**（§4）：program が拒否しない自分宛・署名できない宛先（PDA）・system の口座を署名前に拒否 | 譲渡の画面は**模擬 chain の browser 試験だけ**：実 program・通常 world では未実行。一般の市場では売買できない（MARKET-COMPAT）。専用の売買経路は模擬だけ |
| 表示 | 発行ページは日英。TEST の表示（価格・販売・注意書き）を保持 | 公開時の注意書き・規約（A9）、`priceLabel`・`test:false` の設定を `--rpc` 接続でも渡せるようにするか |
| 配備用ファイル | 住民 program の `.so` は記録した build（`program-artifact.mjs status` OK）。`mpl-core` のスタック超過の警告（U26） | 配備先・program ID の鍵・upgrade authority の形（A1・A2） |

## 3. 完了条件（この branch で言えること）と残課題

**完了している（証拠あり）**：最新の住民 program の build と記録／実 Core＋実 program の発行（模擬・実 chain）／NFT lane の実 CreateSeason／通常 world で 発行 → 保有 → 参加 → 最初の村 → 譲渡 → 旧持ち主の画面での拒否（chain 不変）→ 新持ち主の Harvest（chain の蔵が増える）／英語画面と英語の発行ページ／relay の holder gate（transfer guard まで）／host binary の来歴。

**残課題**：
1. ~~通常 world で B の Build・Train・Muster・Depart・Reveal~~ → 取引で照合済み（LOCAL-WORLD §5g）。A の拒否は Harvest・Build を画面で確認し、譲渡後の A の取引 0 件。**残り**：Train・Muster の form の入れ替わり（unit 試験）、入力中の caret の移動と押下中の再描画（手元の browser 試験で再現・修正、LOCAL-WORLD §5h）。**world での人の操作（押下・入力）の確認は未解決**：world 4 は B の Build の押下で止まり、原因は未確定。手札の pop-up は押下の保留の対象外。run data は約 420〜520 MB。
2. 利用者向けの譲渡の画面：**試験用を実装済み（模擬 chain の browser 試験 3 件）**。実 program・通常 world での実行は次の world の枠で（`nft-world-screen-check.mjs --transfer-via page`）。
3. collection・NFT の metadata を後から変える手段（program の更新が要る）。
4. B（wide の領土戦との統合）と C（本番の program・版・配備）は別の判断と作業。
5. 公開にだけ要る判断（§2 の右列、`MINT-READINESS-20261114.ja.md` §6）。実ウォレット・公開 chain・公開販売・実資金は行っていない。

## 4. 試験用の譲渡の画面（同日 夜、領土側の world の実行中：validator・world・build は無し）

発行ページ（`web/mint.html`・`web/mint.mjs`）の「Transfer your resident (TEST)」。検査は DOM の無い `web/transfer.mjs`。ページは**英語が既定**になった（ブラウザが日本語でも英語。日本語は `?lang=ja` か切替で、選択は保存）。

| 要件 | 実装 | 試験 |
|---|---|---|
| 宛先の厳密な検査 | 前後の空白だけ除き、base58 の 32 バイトの公開鍵だけ。curve 上にない宛先（PDA：誰も署名できず住民が二度と動かない）、program・collection・treasury・config・asset 自身を拒否 | `transfer-ui.test.mjs`（6）、browser 1 |
| 自分宛・未接続・他人保有 | 自分宛は `Self`、ウォレット未接続は `NoWallet`、送り主が今の持ち主でない（chain の読取）は `NotYours`。確認の直前にもう一度読む | 同上、browser 2（確認の後に NFT が他へ動いた → 送信前に拒否、送信 0） |
| 対象と宛先の明示確認 | 住民 ID・asset・送り主・宛先の全桁を表示、宛先の保有数の注記、入力欄は確認中は編集不可（変えたら確認をやり直す）、チェックが無いと送れない | browser 1 |
| 二重送信の防止 | 処理中の印・ボタンの無効化・送信前に記録（`wylls-transfer-pending:<wallet>`）。記録がある間は新しい譲渡を始めない | browser 1（ダブルクリックで取引 1 件） |
| キャンセル・拒否・応答の消失 | キャンセル・ウォレットの署名拒否は「何も送っていない」と表示（記録なし）。program の拒否は記録を消して理由を表示。応答の消失は署名の状態 → asset の今の持ち主で決め、**再送しない**。期限切れは finalized が期限を過ぎてから持ち主を読み、送り主のままなら「着地していない」 | `transfer-ui.test.mjs` の判定 8 通り、browser 1（署名拒否）、browser 3（応答の消失＋状態の隠蔽 → 持ち主で「譲渡済み」、送信 1） |
| 操作権が無くなる表示 | 画面の説明・確認のチェックの文・完了の文（「This wallet can no longer play this resident.」） | browser 1 |

模擬 chain は TransferResident を program と同じ検査で実行するようにした（`src/mint-rpc.mjs` `#transferResident`：owner と payer の署名、asset の持ち主、resident・collection・collection authority・Core の照合。効果は持ち主・世代 +1・session 消去）。**実 program（ループバック validator）と通常 world では未実行**：次の world で `nft-world-screen-check.mjs`（既定で譲渡を画面から行う）を走らせる。

### 4.1 誤送信・誤完了の隙の監査と最小修正（同日 17:45〜、validator・world・build は無し）

| 隙（修正前に実際に起き得たこと） | 修正 | 模擬の試験 |
|---|---|---|
| A→B→A の間に応答が消え状態も読めないと、持ち主が A に戻っているので**「着地していない」と誤って完了**していた | 記録に送信時の世代を入れ、照会で今の世代を読む。持ち主が送り主でも世代が上がっていれば「着地し、戻ってきた（世代 0 → 2）」。「着地していない」は持ち主が送り主のまま**かつ世代が同じ**ときだけ（世代が読めなければ「まだ分からない」） | `transfer-ui` 判定 12 通り、browser「A→B→A」 |
| 別タブで同時に送ると、記録を互いに上書きし、片方が**他方の記録で結果を表示・消去**し得た | Web Locks でウォレットごとに 1 件（無い browser は送信直前の記録の確認）。各タブは**自分の記録**で照会し、消すのは自分の署名の記録だけ | browser「2 タブ同時」：取引 1 件、完了表示は 1 タブだけで、その宛先が持ち主 |
| 署名中にウォレットを切り替えると、記録が**新しいウォレットの鍵の下**に書かれた | 記録は署名した送り主の鍵で保存。処理中のウォレット切替を拒否 | （静的な照合） |
| 確認の後にウォレット内で口座・ネットワークを替えても気づかなかった | 署名の前後に、ウォレットが今もその送り主をそのネットワークで出しているかを読み直す（`stillOffers`）。違えば送らない | browser「ネットワーク切替」：送信 0 |
| ウォレットが別の鍵で署名しても記録・送信していた | 署名が送り主の鍵でこのメッセージに対するものかを WebCrypto で検証してから記録 | （静的な照合） |
| 同じ address・port で作り直した local world に、前の chain の記録が残ると**永久に「分からない」**で画面が止まった | 記録に genesis を入れ、違えば照会から外して画面に表示（`…:set-aside` に保管）。読めない記録も同様。外しても二重譲渡にはならない（旧持ち主の 2 回目は program が NotOwner） | browser「別ネットワークの記録」 |
| 記録の保存に失敗（容量・無効化）しても気づかない可能性 | 書いた後に読み戻して一致を確認、失敗なら送らない | browser「保存できない」：送信 0 |
| 署名の直前に接続先 RPC が別 chain に替わる | 署名前に genesis を読み直す | （静的な照合） |

発行（mint）の記録の同じ形の隙は §4.2 で直した。実 program・通常 world では未実行。

### 4.2 発行（mint）の未確定記録の同じ形の隙（同日 18:00〜、validator・world・build は無し）

| 隙 | 修正 | 模擬の試験 |
|---|---|---|
| **2 タブで同時に mint すると、それぞれ新しい asset を作るので 2 回支払う**ことが起き得た | Web Locks でウォレットごとに 1 件。順番を待ったタブは、他のタブの記録、またはすでに出来た保有を見て送らない | browser「2 タブ同時」：取引 1 件・NFT 1 個、完了表示は 1 タブ |
| 前の chain の記録が残ると永久に「分からない」で発行できない | 記録に genesis・wallet・版を入れ、別ネットワークの記録・読めない記録は外して**専用の行に表示**（`…:set-aside` に保管）。別 chain の取引はこの chain に着地し得ないので二重課金にならない | browser「別ネットワークの記録」 |
| 版の無い古い記録（この変更の前のページが書いたもの） | **外さずに照会を続ける**（外すと、未決の 1 件目があるのに 2 件目を払える） | unit・browser「古い記録」：記録は残り mint は押せない |
| 記録の保存に失敗しても送り得た | 書いて読み戻し、違えば送らない（課金なし） | browser「保存できない」：取引 0 |
| 記録の鍵が「今つないでいるウォレット」、照会が保存し直した記録を読む | 記録は支払うウォレットの鍵、各タブは自分の記録で照会、消すのは自分の署名の記録だけ。処理中のウォレット切替は拒否 | unit（静的な照合） |
| 署名の前後のウォレット・ネットワークの変化、別の鍵の署名、接続先の chain の変化 | 署名の前後に `stillOffers`、支払う側の署名を WebCrypto で検証、署名前に genesis を読み直す | unit（静的な照合） |

試験：`mint-record.test.mjs` 2、`browser.mint-record.test.mjs` 4、既存の発行・英語・譲渡の browser 試験と合わせ 42 件中 41 合格（落ちた 1 件は既知の不安定な「途中で離れて戻る」で、変更前の回でも同じ箇所で時間切れ、単独では 3 回とも合格）。実 program・通常 world では未実行。
