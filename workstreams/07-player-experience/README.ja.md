# ⑦ プレイヤー体験（UI/UX と視覚表現）

WYLLS の既存のルールを人が理解して遊べるようにする UI/UX と、「Realms に似ている」という懸念に応える視覚表現の作業一式。基準は `4cd901de`（PR #22 の統合候補）。**本番への merge・配備、push、外部への送信、有料の素材はしていない。**

| 文書 | 中身 |
|---|---|
| [REPORT.ja.md](REPORT.ja.md) | 5 つの主張の検証（再現・不再現・未確認）、局所修正、接続パッチ、テストの結果、未確認事項 |
| [VISUAL.ja.md](VISUAL.ja.md) | 視覚の方向 3 案の比較と、推奨「記録の地図」の決め事（符号の表、優先順位、操作、入れ方） |
| [PLAYTEST.ja.md](PLAYTEST.ja.md) | 人間の試遊で確かめる問い（R1〜R5、V1〜V3、A1）と手順 |
| [CONTRACTS.ja.md](CONTRACTS.ja.md) | ④（取消3段階・到着量未検証）、⑤（費用4区分・手動復帰）の表示契約、① の協力入口、各担当から受け取る必要があるもの |
| [INTEGRATION.ja.md](INTEGRATION.ja.md) | 統合の確認条件（**§0 が修正版 v2**）：commit とパッチの範囲、REPRO と回帰テストの対応、予測と確定の区別、復帰要約の継続性（0002 の統合前条件）、④⑤ との接続条件、証拠の層 |

## 中身

```
src/            ルールに沿ったモデル（画面を持たない純粋な関数）
  s1walk.mjs          柵・物見櫓が歩みに何をするか（structure.rs の移植、ベクトルで固定）
  forecast-model.mjs  予測を、プログラム自身の組み立て（resolve_from_inputs）で出す
  caravan-preview.mjs 隊商を送る前の道・到着・ターンのマス・減り・既知と不明の危険
  shortfall.mjs       不足の解消：待つ・増やす・運ぶ・運ぶ＋増やす・頼むを「全部そろう時点」で比較
  return-summary.mjs  留守の要約：読み込み済みと確認済み、初回・別端末・別ウォレット・新シーズン・欠け
  season-terms.mjs    ターンの長さ・締め切り・用語を、シーズンと時計から言う
  siege-precheck.mjs  包囲の事前判定に足す 3 つの理由と、プログラムに任せる判定
  records.mjs         /h/events の記録の中身（テストと試作の mock 用。ページの復号器で読む）
tests/          通常のテスト（model）：node --test tests/*.test.mjs（43 件）
  repro/        REPRO（基準で欠陥があることの確認。パッチ後は失敗するのが正しい）：node --test tests/repro/*.test.mjs（12 件）
vectors/        ルールの crate が書いた検証ベクトル（s1-walk-v1.json）
rust-vectors/   そのベクトルを書く小さな Rust のプログラム（permutation-rules を読むだけ）
prototype/      操作できる試作（index.html）と 3 案の比較（compare.html）、画面の点検（checks.cjs）
patches/v2/     クライアントへの接続パッチ 5 本（最新。基準 a997a756、順序と依存は SERIES.ja.md）
patches/v1/     前の版の 3 本（保全のため変更せずに残した）
shots/          画面記録（PC 1440×900・スマホ 390×844・暗い配色・白黒・色覚の近似）と動画、checks.json
```

## 動かし方（リポジトリのルートから）

```sh
# モデルと再現のテスト
node --test workstreams/07-player-experience/tests/*.test.mjs

# 試作（ローカルだけ）
python3 -m http.server 41777 --bind 127.0.0.1
#   http://127.0.0.1:41777/workstreams/07-player-experience/prototype/index.html
#   http://127.0.0.1:41777/workstreams/07-player-experience/prototype/compare.html
node workstreams/07-player-experience/prototype/checks.cjs   # 画面の点検と記録（上のサーバーが要る）

# 検証ベクトルを作り直す（Rust 1.89）
cd workstreams/07-player-experience/rust-vectors && cargo +1.89.0 run --release > ../vectors/s1-walk-v1.json

# 接続パッチを当てる（試す場合。このブランチには当てていない。基準 a997a756 の上で）
git am workstreams/07-player-experience/patches/v2/*.patch

# REPRO（パッチを当てる前の木で通る）
node --test workstreams/07-player-experience/tests/repro/*.test.mjs

# S1 部品の画面テスト（パッチ 0005 を当てた木で。permutation-gateway/screens から）
node --test ws07-s1.screen.mjs
```

## 担当の境界

- ① が国のルールと国の卓、⑥ が作成・公開の体験を担当する。⑦ では国の制度も作成ツールも作っていない。
- 不足の比較の「頼む」は、① の国の卓の契約が決まっていないため、**時間を出さない mock** にした。
- ② ③ ④ の契約にはつないでいない。
- 共有のコントローラー（`controller.mjs`、`app.mjs`）・ナビ・翻訳辞書（`lang/en-*.mjs`）への変更は、すべて `patches/` に入れた。④へ渡すパッチとして分けてあり、他担当のブランチには当てていない。ブランチに入れた局所修正は、地図のガイド（`hud/guide.mjs`）の 1 件と、その回帰テストだけ。

## 試作のデータについて

試作の世界（`prototype/world.mjs`）は**試作用の架空データ**で、画面にもそう書いた。数値は、上のモデル（テストで固定）とページ自身のルールのコードで計算している。予測の点検だけは、ローカルチェーンで記録された州のデータ（`permutation-gateway/test/fixtures/uxs1-keep-two-turns.json`、MC の季節）と、S1 の規則モジュールを使う。

## リポジトリの決まりについて

依頼にあった `AGENTS.md` と関連スキルは、基準 commit にもどのブランチにも無かった。`docs/DEVELOPMENT-HANDOFF.ja.md` と、各文書の決まりに従った。
