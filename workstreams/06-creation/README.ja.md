# ⑥ 住人が仕組みを作り、公開し、他の人が使い直す

**基準：** 共通基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補の祖先。main 統合済み・CI 全成功とは扱わない）。ブランチ `claude/wylls-creation-publishing-reuse-31aiyj`。成果物はこのフォルダだけにあり、共通コア・他担当の仕様・共有 UI・CI は変更していない。

**一言で：** 既存の命令（S1 の荷車、S2 の札の命令）を組み合わせる **型つきの定義（manifest）** と、その **検証器**、そして「作る → 条件を確認 → ローカルの一覧へ公開 → 別の利用者が選ぶ → 実行前に不足を確認 → 写して編集」を操作できる **試作** です。プログラミングは参加の条件にしていません（見本を選んで、場所と数を選ぶだけで作れる）。

## 何が本物で、何が模擬か

| | 状態 | 説明 |
|---|---|---|
| 定義の形式・検証器・紙の自動生成 | **動く** | `src/`。Node とブラウザの両方で同じコード |
| 署名（作者の公開・利用者の計画・状態の変更） | **動く**（鍵は模擬） | WebCrypto の Ed25519。鍵は repo に書いた固定の種（demo seed）から作る。秘密ではないので何も預けないこと |
| ローカルの一覧への公開・停止・取り下げ・版の管理 | **動く** | メモリとブラウザの localStorage だけ。**インターネットへの公開や外部登録はしていない** |
| 写して編集（A） | **動く** | 写らないもの（署名・札・物・記録・作者の場所の既定・主張・説明）を一覧にして示す |
| 実行前の確認（B の権利・C の成果・場所・容量・在庫・署名） | **動く**（世界は模擬） | 世界のスナップショットは S1 の場所と、**未統合ブランチ `ccr-184d6862-fqutoz` の S2 の札の規則** を写した模擬データ |
| 実行 | **模擬だけ** | `src/run.mjs`。チェーン・中継サーバー・ウォレットに **何も送らない**。荷車はすぐ着く（襲撃は指定したときだけ）。完了記録も模擬の台帳（④の代わり） |
| 実世界（ゲームのチェーン）への作用 | **できない** | ④の Run が⑥の計画を受け取って既存の命令を送る部分は、まだどこにもない |
| 新しい種類の世界効果（D） | **追加していない** | 分類と比較だけ（[docs/04](docs/04-world-effects.ja.md)）。任意コード実行は入れていない |

## A・B・C・D の区別

| | この試作での形 | 必要なもの |
|---|---|---|
| **A 定義を写す** | `forkManifest`：定義の構造だけを写し、`derivedFrom` に元を記録 | 新しい作者の署名。写しは何の権利も成果も持たない |
| **B 他人が動かしている施設へ接続** | `uses.*.relation = "connect"`（例：Wの工房へ、使用権の札で） | 利用者自身の札（S2 の束）。実行前に持ち手・発行元・世代・期限・残り回数を確認 |
| **C 確定した成果を使う** | `uses.*.relation = "consume"`（例：Mの鉱山の便が届いた記録） | 台帳にある、確定した、成功した、自分が受け取り手の、未使用の記録 |
| **D 新しい世界効果** | 定義には書けない（`EFFECT_UNKNOWN`／`EFFECT_FORBIDDEN`） | コアの拡張（新しいシーズン） |

A だけでは B〜D はできません。写した人は、元の作者の札で工房を動かせず（`GRANT_NOT_HELD`）、元の記録も使えません。

## 例：他人の工房を使う補給計画を、入力元と受取先を変えて使い直す

1. **作者A** が「前線補給」を作る：自分の鉱山の倉 → 工房と同じ州の自分の倉へ材料を運ぶ → **工房主W** の工房を使用権の札で3回動かす → 兵器12を前線の倉へ送る。条件を確認し、Aの鍵で署名してローカルの一覧へ公開。
2. **利用者B** が一覧で「兵器」と探して選ぶ。紙（機械が書いたもの）とAの説明は分けて表示される。
3. B は **自分の鍵だけで** 計画を準備する。実行前の確認：`MISSING_GRANT`（Wの工房の使用権の札がない）、在庫の不足（警告）、Dの砦あてはウォレットの署名が要る（知らせ）。
4. B が A の定義を写す。写らないもの：Aの署名、札、倉の中身、実績、Aの場所の既定、Aの主張と説明。署名のない写しは公開できず、Aの名前で出そうとしても `SIGNATURE_INVALID`。
5. B が写しを編集する：**入力元** を「自分で運ぶ」から「**鉱山主M** の便が自分の峠の倉に届いた記録（C）」に替え、**受取先** を入力のまま残して自分で決める。Bの鍵で公開。
6. 写した直後の計画は、入力が未設定・札がない・記録がない（`PARAM_UNBOUND`・`MISSING_GRANT`・`RECEIPT_INVALID unbound`）。Aの束を名指ししても `GRANT_NOT_HELD`。
7. B が W から使用権の札を得る（S2 の引き換えを模した操作。定義の外）。M が便を走らせ（模擬）、届いた記録ができる。
8. B の計画が `ready` になり、模擬実行で Dの砦に兵器12が届く。同じ届いた記録は二度使えない（`already-consumed`）。

## 動かし方

```sh
# テスト（依存なし。Node 20/22）
node workstreams/06-creation/cli/fixtures.mjs --check
node --test workstreams/06-creation/test/*.test.mjs

# 上の例を端末で通す
node workstreams/06-creation/cli/demo.mjs

# ブラウザの試作（127.0.0.1 だけで待ち受け）
node workstreams/06-creation/proto/serve.mjs      # → http://127.0.0.1:8606/proto/
# ブラウザの通し確認（Playwright が要る。開発用コンテナにはある）
node workstreams/06-creation/proto/e2e.mjs [画像の保存先]
```

画面の使い方：上の「今の人」で 作者A／利用者B／工房主W／鉱山主M／Bの味方D を切り替えます。どの操作も今の人の鍵だけで署名し、「世界と台帳」タブの署名の記録で、誰の鍵が何に署名したかを確かめられます。

## 成果物の地図

| 課題の納品物 | 場所 |
|---|---|
| 既存の S2〜S4 設計・SDK・公開機能の確認 | [docs/01-survey.ja.md](docs/01-survey.ja.md) |
| 定義形式 | [docs/02-manifest-format.ja.md](docs/02-manifest-format.ja.md)、`src/manifest.mjs`・`src/types.mjs`・`src/catalog.mjs` |
| 検証器 | [docs/03-validator.ja.md](docs/03-validator.ja.md)、`src/validate.mjs`・`src/registry.mjs`・`src/plan.mjs`・`src/codes.mjs` |
| 動く作成・利用・写しの試作 | `proto/`（ブラウザ）、`cli/demo.mjs`（端末） |
| 成功／失敗の fixture | `fixtures/ok/`（4件）・`fixtures/ng/`（23件）・`fixtures/cases.json`・`fixtures/world.json`（`cli/fixtures.mjs` で再生成、`--check` で一致を確認） |
| 既存機能で表現できる範囲と拡張が必要な範囲 | [docs/04-world-effects.ja.md](docs/04-world-effects.ja.md) |
| 更新時の既存利用者の扱い（判断案） | [docs/05-update-policy.ja.md](docs/05-update-policy.ja.md) |
| ②③④とのつなぎ目・接続差分の提案 | [docs/06-interfaces.ja.md](docs/06-interfaces.ja.md)、`proposals/` |

## テストの結果（2026-10-29、このブランチの commit で実行）

| テスト | 結果 |
|---|---|
| `node --test workstreams/06-creation/test/*.test.mjs`（Node 22.22.0） | **57 通過・0 失敗** |
| 同上（Node 20.20.0、今の CI の版） | **57 通過・0 失敗** |
| `cli/fixtures.mjs --check` | 一致 |
| `cli/demo.mjs` | 最後まで動く（テストにも含む） |
| `proto/e2e.mjs`（ヘッドレス Chromium） | **16 項目すべて ok**、ページのエラーなし、幅 390px で横スクロールなし |
| repo の既存テスト（Rust・gateway・web） | **未実行**。⑥は既存のファイルを変えていない |
| GitHub の CI | **未実行**（push していない） |

## 判断してほしいこと（まとめ）

1. D は当面「コアだけが足す」に限るか。次の候補として「型つきの効果の雛形」を段階3と合わせて検討するか（[04](docs/04-world-effects.ja.md) §4）。
2. 作者の停止で既存の計画も止めるか、警告だけにするか（[05](docs/05-update-policy.ja.md) §3）。
3. 作者の説明だけの変更（patch）を、利用者の確認なしに追従させてよいか（同）。
4. ②③④の担当に、[proposals/](proposals/) の形を渡すか。

## 変えていないもの

共通コア（`frontier-abi`・`permutation-frontier`・`permutation-rules`）、他担当の仕様、共有 UI（`permutation-server/web`）、CI の設定、既存のどのファイルも変更していない。push・main への merge・deploy・課金・実資金の利用・既存作業の停止や削除はしていない。
