# 賞金の受取権と、シーズン終了後の後始末（close）の順序（④、2026-11-06）

対象は旧来の「シーズン終了で精算する」賞金 pool です（今の方針では世界は終わりませんが、すでに作られた pool と入金は残っています）。賞金のルール・金額・受取の期限は変えていません。期限は今もありません。

- **基準**：④ `claude/gallant-ride-cunptv` `b858e40d954cdc2ebbcac5a7edb8a251fb701730`。統合候補 `ef63544c727490fc6801d30affd11c5b7106c480` の上にあります。
- **再現と修正候補の commit**：`f43eb4eb86f9aec6949ecf361ea13d35694ff639`（この文書は、その次の commit）。
- **実行**：ゲーム program（`permutation-frontier` の `dispatch`）と賞金 program（`permutation-prize` の `process_instruction`）を、それぞれ本物のコードとして host で動かしました（`e2e-native` の `Host::with_game`）。
  - System、SPL Token、時計は MOCK です。
  - ゲームの口座（終了時の Season、Citizen、Province、ProvinceFund）は、frontier-abi の layout で本来の address に書いた**代役**です。Join・プレイ・EndSeason は実行していません。
- **鍵**：鍵の生成・導出・署名は一切ありません。すべての key は固定の 32 byte か、program address です。署名者は host が持つ key の集合です。
- **テスト**：`workstreams/04-execution/e2e-native/tests/claims_vs_closes.rs`（12 件）。

## 1. 再現できたこと（本物のゲーム program と本物の賞金 program）

| # | 条件 | 結果 | テスト |
|---|---|---|---|
| A | Season Ended。勝った国の b が、まだ Claim していない。`now ≥ bell_start(genesis, end_bell) + 72 h` | **誰でも**（第三者 `key(77)`）CloseCitizen(0x37) を送れて、通る。rent は b に戻る。その後、b の Claim は正しい proof でも `BadAccount`（0x101）になり、**ずっと拒否される**。b の取り分は金庫に残り、出口がない。72 h の 1 秒前は、ゲームが `TooEarly`(13) で拒否する。CloseCitizen は賞金を一切見ない。Join は終了後に閉じているので、Citizen は戻らない。 | `a_third_partys_close_citizen_after_the_grace_strands_an_unclaimed_share` |
| B | 72 h 後、Tally の前に、第三者が CloseProvince(0x24) を送る | ゲームの ProvinceFund の `provinces_opened` も 1 減る。そのため Finalize は「その keep がない地図」と一致し、**エラーなしで確定する**。例では国 1 の 10 個目が消え、10 対 9 だった単独勝ちが、9 の同数に変わった。 | `a_province_closed_before_tally_is_left_out_silently` |
| C | Tally が数え終わった後に、第三者が CloseProvince を送る | counted は 54 のまま、ゲームの数は 53 になる。Finalize は `WrongExpectedCount`（0x110）で、**ずっと**確定できない。Tally を数え直しても bitmap で何も起きない。終了後は Province を開き直せない。pool は Open のままで、何も出せない。 | `a_province_closed_after_tally_makes_finalize_impossible` |
| C' | Tally と Finalize が 72 h 以内に済んでいれば | その後の close は結果に影響しない。Claim も通る（Citizen がまだある人は）。 | `tally_and_finalize_within_the_grace_are_unaffected_by_later_closes` |
| D | Pay を Ended の後、さらに 72 h の後に送る | 受け付けられる。Pay が見るのは pool の状態と `COUNTED == 0` だけだから。Tally が 1 つでも数えた後は `WrongState`。 | `pay_is_accepted_after_the_end` |
| E | Season が Aborted | Tally も Finalize も `SeasonNotEnded`。入金に出口がない。 | `an_aborted_season_leaves_the_pool_without_an_exit` |

コードを読んで確認したこと（host では未実行）：

- **CloseSeason**（0x05、class O、authority）は 72 h 後に実行でき、最後の part で Season を 128 B の tombstone に縮め、ProvinceFund を閉じる。その後は Tally・Finalize の `game_account(season, S::SIZE)` が合わなくなり、`BadAccount`。Finalize 前に実行されると pool は確定できない。
- 最後の part は `provinces_opened == 0` を要求するので、CloseSeason の前に全 Province が閉じられている。これは上の B・C と同じ問題を含む。
- 根拠：`permutation-frontier/src/proc/season.rs` 943–961、`proc/citizen.rs` 2447–2510（CloseCitizen）、`proc/map.rs` 151–167（72 h の判定）、917–966（CloseProvince）、`permutation-prize/src/lib.rs` の pay / tally / finalize / claim。

賞金 program の冒頭の説明には「Ended の後、`end + 72 h` までは Province は開きも閉じもしない」とあります。つまりこの program は、Tally と Finalize が 72 h 以内に済むことを前提にしています。その前提を、program 自身は強制していません。

## 2. 受取権の修正候補：RecordNation（実装済み・候補）

**変更**は `permutation-prize/src/lib.rs` です（④の branch のみ。main・deploy はしていません）。同じ内容を `workstreams/04-execution/patches/prize-record-nation-20261106.patch` にも置きました。

- **新しい命令**：tag 7 `RecordNation`。口座は `[pool] [entry w] [citizen]` で、署名は不要です。誰が送ってもよく、pool の状態も問いません。
  - Entry を検証します：owner、magic、size、`entry.POOL == pool`、Entry の PDA が entry 内の wallet から再計算した値と一致すること。
  - Citizen を検証します：pool のゲームと season のもので、その wallet の address にあり、`C::WALLET == wallet` であること。
  - その Citizen の国を、Entry の未使用 byte 10（記録済み = 1）と byte 11（国）へ写します。
  - 2 回目は何もしません。違う国の記録は `BadAccount` で拒否します。token も lamport も動かしません。
- **Claim の変更**（shares mode だけ）：
  - これまでどおり、生きている Citizen を読みます。
  - **その Citizen の address が空のとき**（閉じられた口座）**だけ**、Entry の記録を国として使います。
  - 勝った国か、proof、点数、金額、一度だけであること——ここは何も変えていません。
  - address は今もその wallet の正しい Citizen の address だけを受け付けます。
- **ルールが変わらない理由**：
  - ゲームが Citizen の国（`C::FACTION`）を書くのは Join の 1 回だけです（`proc/citizen.rs:421`。ほかに書く所はありません）。
  - 記録は「Claim が Citizen から読んだはずの値」と同じです。
  - 受取の期限は足していません。誰がいくら受け取れるかも変えていません。
  - 記録のない Entry は、これまでとまったく同じ動きです。
- **確かめたこと**（`claims_vs_closes.rs`）：
  - 記録してから Citizen を閉じても、b は正しい額をちょうど受け取れる。
  - 記録があっても、proof 違い（`BadProof`）、国違い（`NotWinner`）、他人の Citizen（`BadAccount`）、2 回目（`AlreadyClaimed`）は、これまでどおり拒否される。
  - 記録がなければ以前と同じで、受取は失われる。閉じた後には記録できない。
  - 他人の Citizen や、ゲームの口座でない Citizen は記録できない。
  - 負けた国の記録は `NotWinner`。
  - refund mode は変わらない。
  - 既存の `legacy_season_claims`（D3 の旧動作を含む）は 4/4 のまま通る。prize の単体テストは 5/5。
- **限界**：Citizen が閉じられる**前に**、誰かが RecordNation を送る必要があります。
  - 国は Join のときに決まるので、Join の直後から送れます。
  - 受け取る本人も、関係のない第三者・keeper も送れます。
  - 閉じられた後の Entry は、この修正では戻せません（→ 4. 移行）。

### ⑰の対策との照合

⑰の D3 の記述（`CONTINUITY.ja.md` の「精算と受取の前に CloseCitizen を止めるか、Claim が Citizen を要求しない経路が要る」）と、報告にあった C2 の (i)・(ii) を比べました。

| 案 | 既存の受取権 | ルール・信頼の変化 | 変更する program | 懸念 |
|---|---|---|---|---|
| (i) CloseCitizen が、未受取の Entry を見て拒否する | 守れる（記録が要らない） | ゲームの後始末の規則が変わる | **ゲーム**（賞金 program の id・PDA を知る必要がある。program 間の新しい依存） | pool が確定しない（E、C）と、Citizen の rent が永久に戻らない。拒否の条件（勝者か、shares か）を決める必要がある |
| (ii) Claim が leaf の国を信じ、Citizen を要求しない | 守れる（記録が要らない） | **信頼が変わる**。国の判定が、chain の Citizen から operator の root だけに移る。operator が支払った wallet に勝った国を割り当てられるようになる | 賞金 | 賞金の検証規則の変更。owner の判断が要る |
| 運用だけ（精算が済むまで Close* を送らない） | 第三者の close は止められない（class N） | なし | なし | 守れない |
| **RecordNation（④）** | 記録してあれば守れる | なし（同じ値を、同じ出所から先に写すだけ） | 賞金だけ（ゲームは変えない） | 閉じられる前の crank が要る |

④の推奨は次のとおりです。

- RecordNation を入れ、Join・Pay の後、遅くとも `end + 72 h` の前に、すべての Entry に crank します。
- (i) は、program 間の依存と rent の永久ロックを伴います。(ii) は信頼の変化を伴います。どちらも賞金・ゲームの規則の判断なので、④だけでは決めません。
- ⑰に照合を依頼しました（返事待ち。返事は §5 に追記します）。

## 3. close の順序による集計漏れ・確定不能（B・C・E）：修正候補（未実装・判断が要る）

どの案も「誰がいつ閉じられるか」か「確定できないときにお金をどうするか」を変えます。賞金・ゲームの規則に当たるので、④は実装していません。

| 案 | 内容 | 効果 | 決めること |
|---|---|---|---|
| K1 運用 | Tally・Finalize・RecordNation を `end + 72 h` 以内に終える（keeper が担う） | コードの変更はない。B・C・A を避けられる | 72 h を逃したときの扱い。逃しても第三者の close は止められない |
| K2 賞金側の終了時スナップショット | `end + 72 h` より前に限り、誰でも `Σ provinces_opened` を pool に記録できる（賞金 program は Season の genesis と end_bell から期限を計算できる）。Finalize はスナップショットがあればそれと比べる | C が解消する（後の close で Finalize が壊れない）。B は「黙って勝者が変わる」から「`TallyIncomplete` のまま止まる」に変わる | B で止まった pool の扱い（refund mode に移すかなど）。pool の layout の空き byte の割り当て |
| K3 ゲーム側 | CloseProvince・CloseCitizen を class O（authority）にするか、tombstone の後だけにする | 第三者の close がなくなる | ゲームの後始末の規則。authority の運用 |
| D | Pay を Running の間だけにする（Season を Pay の口座に足す） | 結果を見てから払うことを防ぐ | 今は、勝った国の Citizen が終了後に支払い、operator の root に入れば受け取れる。これを認めるか（賞金の規則）。Pay の口座の並びが変わる |
| E | Aborted の pool の出口（refund など） | 入金を戻せる | 賞金の規則 |

## 4. 既存の資金への移行上の注意（実際の deploy と被害の有無は不明）

1. **deploy の確認が先**：
   - 賞金 program がどこに deploy されているか、④は知りません。
   - pool があるか、どの season か、Ended か、`end + 72 h` を過ぎたかも知りません。
   - 被害の有無は、chain の上で次を数えて判断します：shares mode の pool で、`entry.CLAIMED == 0`、勝った国、Citizen の address が空——の Entry。
2. **RecordNation には program の upgrade が要る**：
   - pool・Entry の大きさは変わりません。既存の Entry の byte 10–11 は 0（記録なし）なので、upgrade の直後も以前と同じ動きです。
   - Claim の口座の並びは変わりません。Citizen が閉じられていても、正しい address を渡します。
3. **upgrade の直後に、Citizen が生きているすべての Entry に crank する**：
   - 対象は、まだ `end + 72 h` 前の pool のすべてです。期限後でも、Citizen が残っている Entry はすべて対象です。
   - crank は受け取る本人の署名を要りません。署名は手数料を払う人だけです（鍵の扱いは運用側。④は試していません）。
4. **すでに Citizen が閉じられた未受取の Entry は、この修正では戻せない**：
   - chain の上に国の証拠が残っていないからです。
   - CloseCitizen の取引の記録（log）に残る内容から国を示せるかは、④は確かめていません。
   - 救済するなら、operator の証言などの別の信頼に頼ることになります。賞金の規則の判断です。
5. **close の順序**：
   - Finalize 前の pool がある season では、まず Tally と Finalize を済ませます。
   - その前に CloseProvince や CloseSeason が送られた場合：
     - Tally 後に閉じられたもの → C。確定できない。
     - Tally 前に閉じられたもの → B。黙って漏れる。
   - 該当がないかを、`counted` と ProvinceFund の合計で確かめてから進めます。
6. **Pay**：
   - 終了後も受け付けられています。終了済みの pool への支払いが届いていないか、Entry の `PAID_SLOT` と Season の終了時刻で確かめます。
   - 扱いは賞金の規則です。

## 5. 未解決・判断待ち

- **72 h の起点**（⑯の指摘 (4)、コードで確認）：起点は予定の終了時刻（`bell_start(genesis, end_bell)`）で、EndSeason を送った時刻ではない。EndSeason が予定の終了＋72 h より遅れると、Ended になった瞬間から CloseCitizen・CloseProvince が通る。そのため、Tally・Finalize・記録の猶予は 0 になりうる。RecordNation は Ended を待たずに Join の直後から送れるので、この競争を避けられる。
- **⑰の Attest との一本化**：⑰も同じ tag 7 に別の候補 Attest を作った（Ended の後だけ記録でき、Entry の byte 104–105 を使う。⑰の bundle は④には未受領）。上の理由で「Ended を要求しない」ことを⑰に提案し、program 本体は⑰に任せる案で調整中。合意できれば、④の RecordNation は revert で取り下げる。
- ⑯の probe（`claude/dreamy-ramanujan-ijj8qj` `32b367b741b57bc69cfa92cb312bc6aa6441ee8f` の `verification/16-independent/probes/v16_prize_claim_rights.rs`）は、f43eb4eb の上で 6/6 合格した（一時的に置いて流しただけで、commit はしていない）。記録のない Entry の動きは変えていないので、修正の後も同じく通る。

- ⑰の照合結果（送付済み・返事待ち）。
- RecordNation の番号（tag 7）と Entry の byte 10–11 は、**仮**です。
  - 2026-11-06 に取得済みの remote 130 ref では、賞金 program に tag や Entry 欄を足すものはありませんでした（`tools/prize_tags.sh <repo>` で読むだけ）。
  - `abi_inventory.py` は、まだ賞金の tag と Entry layout を数えていません。
- `permutation-prize/svm-tests`（LiteSVM、SBF build）は実行していません。鍵の生成を含むおそれがあるためで、host の 12 件と単体の 5 件だけです。
- K1〜K3、D、E は判断待ちです（§3）。
- ゲームの代役の口座（Citizen、Province、Fund、Season）は layout から書いたもので、Join・EndSeason の実際の出力ではありません。
