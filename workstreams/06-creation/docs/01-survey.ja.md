# 1. 既存の設計・SDK・公開機能の確認

**確認した基準：** 共通基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補 `integrate/claude-consolidation-20261029` の祖先。main 統合済み・CI 全成功とは扱わない）。あわせて、remote の未統合ブランチ `ccr-184d6862-fqutoz`（@ `0677572e`、2026-10-24）を読んだ。

書き方：**［事実］** はファイルで確かめたこと、**［判断］** は⑥の判断、**［未確認］** は確かめていないこと。

## 1. 文書と作業の入口

- ［事実］`AGENTS.md` は基準 commit にも、ほかの remote ブランチにもない（`find` で確認）。関連スキル（`.claude/skills/` など）も repo にない。入口として使えたのは `docs/DEVELOPMENT-HANDOFF.ja.md` と `docs/design/redesign/README.ja.md`。
- ［事実］handoff は「提案ブランチを、採用済み仕様として扱わない」「作業ごとに独立ブランチ」を求めている。⑥はこれに従い、成果物をすべて `workstreams/06-creation/` に置いた。
- ［事実］②（Grant）・③（命令型）・④（Run/Receipt）の成果物は、基準 commit にも remote の全ブランチ・PR にもない（PR #13〜#22 と全 remote ブランチの `workstreams/` を確認）。⑥はこれらを「必要とする形」だけを書き、中身は定めない（[06-interfaces](06-interfaces.ja.md)）。

## 2. 段階2〜4の設計（設計文書）

| 段階 | 文書 | 採用された決まり（99 の決定ログ） | ⑥への意味 |
|---|---|---|---|
| S2 札と引き換え | [20](../../../docs/design/redesign/20-stage2-play.ja.md) | 5章：奪われた倉の札は無効、足りなければ割合で減らす、受け渡しで清算、札の発行に費用、札は国と無関係（2026-10-23）。A1〜A3：札3種、材料は荷車で運ぶ、預かりは物と札だけ | 「他人の施設へつなぐ（B）」の権利は札。⑥は札を作らず、必要な札を **書く** だけ |
| S3 条件と繰り返し | [21](../../../docs/design/redesign/21-stage3-play.ja.md) | 2章：合図4種（時刻・量・到着・公開の事実）、すること2つ（送る・動かす）、ターン始めにまとめて判定、手数料前払い、最小量と上限、失敗は止まって記録。B1〜B3 | 自動実行は決まっているが **未実装**。⑥の定義は合図を書けるが、今は手で実行するだけ（`TRIGGER_UNAVAILABLE`） |
| S4 まとめる・公開・テンプレート・AI | [22](../../../docs/design/redesign/22-stage4-play.ja.md) | 4章：紙は自動で書き作者の説明と分ける／条件変更は新しく出す札にだけ効く／前払いが尽きた仕組みは一覧から外れる／AIの案は本人が確認／写すのは自由・費用あり・元の作者への支払いなし。C1〜C4 | ⑥の担当範囲そのもの。紙の自動生成、作者の説明の分離、写し、版の扱いはこの決定に沿わせた |
| 部品 | [16](../../../docs/design/redesign/16-primitives.ja.md) | 2章の世界のルール：無から増えない、許可なく触れない、運ぶには時間がかかり襲われうる、失敗は止まるだけ、中身は公開 | ⑥の「コア拡張が要る／禁止」の分類の根拠（[04](04-world-effects.ja.md)） |

［事実］README の「フェーズ7より前にコードを書かない」と、段階1が実装に進んだ事実の食い違いは、README 自身が「決まっていない」と書いている。⑥の試作は、本番のコード（program・ABI・web）を変えず、`workstreams/` の中だけの試作として作った。

## 3. 実装の状態（コード）

### 3.1 基準 commit（main 相当）にあるもの：S1 だけ

- ［事実］`frontier-abi/src/v2/tags.rs`：S1 の命令 0xB0〜0xBE（BuildVault, SendCaravan, SettleCaravan, RaidCaravan, SeizeVault, CloseVault, DefaultRaid, BuildStructure, …, Propose, Vote, RaidDomestic）と 0xC0 FastForward。**札（S2）の命令はない。**
- ［事実］工房（S1 1a）は村の建物で、村の鉱石と木材を1時間に兵器4へ途切れなく変える（`permutation-rules/src/frontier/arms.rs`、8+4→4）。「1回動かす」単位はない。
- ［事実］荷車は送り元の持ち主だけが出せる。自分以外の場所あての送りは、ウォレットの署名が要る（`docs/frontier/stage1b/S1-1B-CONTRACT.md` §3.2–3.3）。倉の容量は資源ごとに 5000、届いた荷が容量を超えた分は失われる（同 §3.4 の 3）。
- ［判断］したがって **main だけの世界では、「他人の工房を権利つきで使う（B）」は表せない**。材料を工房の持ち主に送り、兵器を送り返してもらう約束は、口約束（信頼）でしかない。⑥の検証器は、main だけの世界で工房の手順を使う定義を `EFFECT_UNAVAILABLE` で止める（`fixtures/ng/effect-unavailable-on-main.json`）。荷車だけの定義は main の世界でも通る（`fixtures/ok/base-only-caravan.json`）。

### 3.2 未統合ブランチ `ccr-184d6862-fqutoz` にあるもの：S2（2a〜2e）

- ［事実］`IssueTickets`(0xC0) `GiveLot` `CloseLot` `OpenShares` `WithdrawShares` `SettleDeposit` `ClaimReceipt` `WithdrawReceipt` `UseRun`(0xC8) `OpenEscrow` `AcceptEscrow` `CancelEscrow` `WithdrawEscrow`。契約は `docs/frontier/stage2/S2-2A〜2E-CONTRACT.md`。
- ［事実］札は「発行（Issue）」と「束（Lot）」の2つのアカウント。束は持ち手ごと。発行元の世代（`SRC_GEN`）と建てた時刻（`SRC_STAMP`）が変わると、その発行元の束はすべて無効（2a §1）。
- ［事実］使用権の1回（`UseRun`）は、工房と **同じ州にある利用者自身の共有でない倉の中で**、鉱石8・木材4を兵器4に変える。上限は束ごとに `AMOUNT × PER_UNIT` 回/日、工房ごとに 工房の数×24 回/日（2d §1、§3）。兵器が倉の容量を超えるなら拒否（`BadData`）。
- ［事実］このブランチは S2 だけを動かすプログラムに切り替わるため main にマージされていない（README の 2026-10-26 追記）。
- ［判断］⑥の試作の世界（`fixtures/world.json`）は、この S2 の規則を **写した模擬データ**。`features: ["base", "s2-branch"]` と明示し、画面にも出す。S2 が main に入ったことを意味しない。

### 3.3 SDK と公開機能

- ［事実］JS の SDK は `permutation-gateway/client/src/frontier/`（web への写しは `permutation-server/web/sdk/frontier/`）。中身は ABI の表から生成した命令タグ・CU 予算・エラー・レイアウト・コーデック・中継の形（`shapes.mjs`）。**命令を1つずつ組んで送る道具** で、複数の命令を名前つきの「仕組み」にまとめる型・公開・写しの概念はない。
- ［事実］「仕組みの公開」「テンプレート」「写して作り変える」「仕組みの紙」を実装したコードは、基準 commit にも S2 ブランチにもない（`publish`/`template`/`manifest` を web・gateway・SDK で検索。web の `publishNoGo` は画面のレイアウト通知で無関係）。
- ［事実］甲の試遊キット（`docs/frontier/playtest-kou/CARDS.ja.md`）には、持ち分・受け取り・使用権・預かりの **紙のカード** がある。S2 を手で運用する試遊用で、公開・写しの仕組みではない。
- ［判断］よって⑥は「既存の機能を拡張する」のではなく、**S4 の公開・写しの層を、S1/S2 の命令の上に新しく定義する**。本番の program・ABI・SDK・web には手を入れず、接続の差分は提案（[06](06-interfaces.ja.md)）に分けた。

## 4. 未確認のこと

- ［未確認］②③④の担当が、⑥の想定する形（[06](06-interfaces.ja.md)）と違う形を選ぶかどうか。違えば、⑥の `catalog.mjs`・`world.mjs`・`ledger.mjs` のアダプタを差し替える。
- ［未確認］S2 の実際の herald の `h/tickets.json` から、⑥の世界スナップショット（`places`・`issues`・`lots`）を作れるか。フィールドは 2a 契約 §2 の表どおりに名前を合わせたが、実データで読んでいない。
- ［未確認］CU の数字は ABI の予算表（`frontier-abi/src/v2/budgets.rs`、S2 はブランチの同ファイル）から写したもので、⑥の上限（`CAPS`）は［フェーズ6］の仮の値。
