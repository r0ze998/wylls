# ② 第7回：オーナー判断「② = A」の実装（受取口を倉にする）

**判断（2026-11-18、オーナー、確定）：** StockSwap を採用する。ただし緩和策つき。
- 交換で得た武具は、**施設と同じ州にある利用者の倉（Vault）** に入る。利用者は、それを**隊商で運び出す**しかない（襲撃される物流のまま）。
- 権利の発行は**財布だけ**（セッション鍵では発行できない）。
- 発行には費用がかかる（`04-PROPOSALS.ja.md` §4、設計 20 §5「札を出すのに少しの費用」）。

**状態：** `rights-experimental` の裏に置いたまま（配備不可）。番号（tag 0xD0–0xD5、エラー 200–214、記録 114–119、版の bit 0x2000）は仮のまま。

## 1. 何が変わったか（コードが正）

| 項目 | v1（第6回まで） | 案 A（今回） | 場所 |
|---|---|---|---|
| 受取口（station） | 利用者の**村**（Holding） | 利用者の**倉**（Vault）。施設の州のタイルにあり、利用者のもの・生きていること | `permutation-frontier/src/proc/rights.rs` `issue_grant` |
| 鉱石・木材の出どころ | 村の倉庫 | 倉の `STORES`（倉には隊商でしか入らない） | `reserve_swap` |
| 武具の行き先 | 村の倉庫 | 倉の `STORES`。`CAP − CUSTODY_QUOTA` を超えるなら交換全体を拒否（`VaultFull` 214、新設） | `execute_swap` |
| 戻し（解放・取消） | 村へ（上限超えも可） | 倉へ。鉱石・木材のどちらかが入らなければ両方とも Grant に**凍結**（焼かない） | `unwind` |
| 受取口の固定 | 村の世代・所有者 | 倉の世代・所有者（SeizeVault で世代+1、所有者が変わる → `StaleHolding`） | `pinned_vault` |
| 発行の費用 | なし | `GRANT_ISSUE_COST` = 金 25（**調整可能な仮の値**）。施設の村から払う（所有者の行為として touch する） | `frontier-abi/src/v2/rights.rs` |
| 発行の署名 | 財布だけ | 財布だけ（変更なし。費用を払う前に拒否） | `issue_grant` |
| 記録の連鎖 | ISSUED：発行者の Citizen | ISSUED：発行者の Citizen と施設。交換と戻しは受取口を **Vault** として連鎖 | `frontier-abi/src/v2/log.rs` `chains_of` |
| `station_site` / `STATION_GEN` | 村の site・世代 | 倉の**タイル**・世代（バイト配置は同じ） | ABI・記録 |

**運び出しに新しい道はない。** 倉から出る命令は、既存の SendCaravan（0xB1）だけ。地図を歩き、RaidCaravan（0xB3）で襲われ、倉そのものも SeizeVault（0xB4）で奪われる。Grant は「同じ州の村と倉の間」を、決まった比率（武具1につき鉱石2・木材1）でしか動かさない。

## 2. 費用の値（調整可能）

設計 20 §5 は「数字はフェーズ6」とし、`04-PROPOSALS.ja.md` §4 も値を書いていない。提案に推奨値がないので、**金 25** を仮に置いた（倉の費用、木材200・石200・金50 のおよそ 1/8）。安く発行できるが、乱発はただではない、という水準。定数は `frontier_abi::v2::rights::GRANT_ISSUE_COST`。

## 3. 自分の別アカウントへの発行（04 §4 の悪用）

- 受取口は**同じ州の倉**だけ。別の州の倉、村は `BadStation`。
- 武具は別アカウントの倉に入るだけで、どの村にも入らない。使うには隊商で運ぶしかなく、その隊商は他人のものと同じく襲われる（LiteSVM で確認）。
- 鉱石・木材は利用者の倉から出る。倉に入れるにも隊商が要る。
- 1枚ごとに金 25 かかる。比率は固定で、他の資源は運べない。

## 4. 新しく分かったこと

- **rights の build は季節を作れなかった。** 版 `0x2004` は `SeasonParamsV2::validate` の一覧（3/4/5）にない。host のテストは季節を直接書いていたので、隠れていた。localnet の遠征 lane と同じ方法（その版だけ範囲検査を S1 として見る）を `rights-experimental` にも足した（`proc/season.rs` `range_view`）。
- 検証器（`frontier-node/crates/verify`、VR）を案 A に合わせた：受取口のアドレスは `v2::addr::vault`、受取口の倉の `STORES` を VR が記録から組み立てて比べる、IssueGrant の施設は V7 が「touch して費用を払う」として組み立てる。

## 5. テスト（2026-11-18）

| 項目 | 結果 |
|---|---|
| host の rights（`map_growth_runtime_tests::rights`） | 43 通過（main では 40。v1 の README の表は 35 と書いていた） |
| host の版の検査（`proc::season::tests::the_rights_build_accepts_exactly_its_own_version`） | 通過 |
| ABI（`frontier-abi`） | 全件通過。`abi-vectors --check` 通過（`v2/logs.json` を再生成。変わったのは仮の kind 114–118 の連鎖だけ） |
| SBF（`scripts/build-frontier.sh --features rights-test-beacon`） | 成功（SBPF v2、配備不可） |
| LiteSVM（`svm-tests/tests/rights.rs`） | 4 通過：倉への交換と隊商での運び出し、運び出しの襲撃、セッションでは発行できない、別アカウントへの発行に安全な道がない |
| 検証器 `verify --test rights_replay` | 19 通過 |

## 6. 遊べる版で有効にするには（未実施）

1. 番号の割当（④の担当）：tag・エラー・記録の kind・版の bit。
2. 版の扱い：`rights-experimental` を既定の build に入れると版が変わる（`06-EVENTS.ja.md` §5：走っている季節の PlaceHome が止まる）。新しい季節から。stack（`frontier-node/crates/stack/src/setup.rs`）は今、版 4 で季節を作る。
3. 同時に build できない組み合わせ：`capacity-preview`（⑨、`lib.rs:276`）、`custody-preview`（`lib.rs:284`）。どちらも版の決め方が未決定。
4. クライアント：web・gateway に Grant の画面と builder がない。relay の許可（03 §8）、MCP。
5. 配備：`build-frontier.sh` は rights の marker を持つ build を配備用として拒否する。
