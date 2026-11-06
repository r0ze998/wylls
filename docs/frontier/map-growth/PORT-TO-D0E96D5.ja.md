# 分散配置・拡張マップの独立移植候補

基点は④ d0e96d5394d88decf878676f37bc3782654d1045 に⑫のローカル修正2件を重ねた b3920a557e8b74fb75027b3a6910d9d77e5e1220。公開・push・CIは行っていない。

## 出典と限界
⑧v9（3f979d18、wylls-08-archive-v9.tar.gz）は取得できていない。本候補はv9の再現ではない。GitHub preserve/ws08-persistence-ca67d40e の handoff-04/live/all-on-base.diff（SHA256 b147a33b0506fe7df1d5e2fe46506ce77c36a270d33fe12d4ffe6ca94faf7b1d）を実物として三者マージした。旧パッチ基点は4cd901de。20ファイルの競合を解消した。

## 維持・接続
- 継続世界フラグ80、NFT記録130と最大kind134、賞金InitPoolの継続世界拒否・状態検査を保持。
- placement77、ceiling78–79、Frontier拡張値66、命令0xC1、記録104を追加。④の割当と一致。
- 既定placement0/ceiling0、keeper自動拡張無効を維持。設定や採否は変更していない。
- Rust/JSで未知のplacement値を拒否。旧UI fixtureのprogram version不足を修正。
- ABIの競合したJSONは構造マージし、SDK同期を実行。アドレス生成を含むabi-vectors全体は実行していないため、生成器との完全な鮮度照合は未確認。

## 実行済み（鍵なしホスト）
- Web placement/live-map/continuous: 23/23。node cryptoガード付き、WASM既存成果物で境界経路も通過。
- rules geometry: 7/7。
- ABI cq_v2_contract: 4/4。presets: 9/9。record specs: 1/1。
- cargo check --locked --offline -p permutation-frontier: 成功。
- cargo check --locked --offline --manifest-path permutation-prize/Cargo.toml: 成功。
- git diff --check: 成功。

## 未実行・未確認
- frontier-nodeのherald/keeper/stack/fclient/botsのcargo checkは、承認機構のauthorization changed before approval could be appliedで未実行。迂回・再試行していない。
- 新たなSBF、LiteSVM、ローカルチェーン、ブラウザ実画面、実ウォレット、本番確認は未実行。
- v9との差分、拡張時の大規模負荷、keeper/herald全州走査、旧ticket経路との境界は追加レビューが必要。
- 上限は半径128、賞金対応は17。無限マップではない。実配備・本番設定の変更なし。

鍵生成・導出・署名の試験、セットアップ・チェーン起動は一切実行していない。コードのコンパイルは実行時の認証を試した証拠ではない。

## 最新④との照合
④ b954990dd148c51b6591907cf61d8931cb9334a5（30a3fd2e荷車Run含む）と競合なしで統合。旧基点以降の④変更と本移植の変更ファイルの重複は0。仮merge treeは9dc220b38ac3834c50e24ef0d248c0e8b6f0e3a6。④の08取り込みは保存文書と引渡しパッチであり、コアへの本移植とは別。新④追加分の実行試験は未実施。

## 独立レビュー後の修正
- JoinResidentの容量が初期R_MAXのみだった不一致を修正。通常Joinと同じmax(初期半径、設定上限、Frontier拡張値)を使い、共通の純粋容量述語へ接続。境界試験1/1、nft-experimental付きhost compile成功。実NFT参加取引の通し確認ではない。
- V11は分散配置のseed/設定欠落を旧扇形に推定せずmissingとして返す。Webも欠落seed/未知modeでは候補をUnavailableにする。Web回帰24/24。V11のcompile・実行は承認不成立のnode確認と同じ範囲であり、再試行していない。
- 最新④統合後の再試験：Web24、幾何7、ABI契約4、presets9が通過。v9未受領・上限128・実チェーン未確認という限界は変わらない。
