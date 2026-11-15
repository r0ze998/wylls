# 広域マップ overview 読取りキューの堅牢化（2026-11-10）

branch `claude2/overview-loading-20261110`、base `8836f1aa`。担当: Fable 5.2。

## 変更したファイル

- `permutation-server/web/frontier/map/overviews.mjs`（修正）
- `permutation-gateway/test/web-frontier-overview-reentry.test.mjs`（新規。第1版 5 件、第2版 8 件）
- この記録

ほかのファイルは変更していない。

## 実行状況

実装担当（この会話）はコードを一切実行していない（Bash・ターミナル・実行ツール不使用）。以下は実行者で区別する。

- **第1版（欠陥 1・2 の修正とテスト 5 件）— 監督側が実行。** no-key-node ガード付きで
  `web-frontier-overview-queue.test.mjs` と `web-frontier-overview-reentry.test.mjs` の 2 ファイルを監査・実行し、
  計 22 件すべて通過（監督側の報告による。実装担当は実行ログを見ていない）。
- **第2版（レビュー対応: 確定時の規則の復元、テストを 8 件に変更）— 監督側が再レビュー・実行。**
  下記のコマンドで 25/25 件通過、失敗 0、ガード違反 0（既存 queue 17 件 + 新規 reentry 8 件）。新規 8 件の意味も
  監督側が確認済み。これは監督側による実測であり、実装担当は実行もログの確認もしていない。

  ```sh
  node --import ./permutation-gateway/screens/codex/no-key-node.mjs --test ./permutation-gateway/test/web-frontier-overview-queue.test.mjs ./permutation-gateway/test/web-frontier-overview-reentry.test.mjs
  ```

第2版をもって overview 担当分は完了。コミット・統合は監督側が行う（実装担当はコミットしていない）。

ガードなしの参考コマンド（実装担当が第1版時点で書いたもの。実測には上のガード付きを使う）:

```sh
node --test permutation-gateway/test/web-frontier-overview-queue.test.mjs permutation-gateway/test/web-frontier-overview-reentry.test.mjs
```

## 直した欠陥

### 1. 応答を取り込んだ後の job に、後から来た要求が相乗りする

応答の処理（保存 → `overviewTaken` → `onChange` 呼び出し）から job の確定（`finally`）までの間、job は
`Q.jobs` に残っていた。その間に同じ ring を要求すると既存 job に合流する。

- `onChange` の中から同じ ring を読み直すと、走査中の `job.changed`（Set）に新しいコールバックが追加され、
  同じ走査の中で呼ばれる。呼び出しごとに新しいクロージャを渡す書き方（インラインの `onChange`）だと、
  1 回の応答の中で同期的に際限なく回る。
- 応答処理と確定の間のマイクロタスクで来た要求は、自分の `onChange` が一度も呼ばれないまま `true` で解決し、
  新しい読取りも行われない（古い応答で「読めた」ことになる）。

修正: 応答を採用すると決めた時点で、呼び出し側のコードが動く前に job を `Q.jobs` から外す。以後の要求は
自分の job を持ち、新しく読む。コールバックは走査前に複製する。応答前の合流（重複要求の共有）は変わらない。

#### 配信時点の意味と、確定時の規則（第2版で訂正）

第1版は「再描画中に extent が変わったら `true` で確定し、次の poll が拾う」としていた。**この説明は誤りで、
挙動としても不十分だった。** `overviewRings` が見るのは欠落と ring ごとの件数だけなので、`rMax`・`ringsOpened`・
`rMaxCeiling`・`rMaxHard` だけが変わった場合は次の poll でも再要求されない。修正前の実装は、この場面でも
（応答待ち中と同じく extent のどの項目でも）読み直していたので、第1版は既存の追従を一部失っていた。

第2版は、共有から外した job にも、確定時に従来と同じ規則を適用する:

| 配信後・確定前に起きたこと | 確定 |
|---|---|
| 何も変わらない／extent が等しい世界への差し替え | `true`（保存済み） |
| クライアントまたは形式の差し替え | `false`（差し替えられたクライアントの job はすべて `false`、従来どおり） |
| ring が世界から消えた | `false`（従来どおり） |
| extent のいずれかの項目が変わり、ring は残る | 現在の世界で読み直してから確定（従来どおり）。その間に同じ ring の要求が来ていれば、その読取りを共有する |

`onChange(ring, answer)` の意味: 「`answer` を、読んだ時点の世界とクライアントに対して `FS.overviews` に保存した」
という通知である。保存は呼び出しの前に済んでいる。同じ配信の中で先の `onChange` が世界やクライアントを変えても、
後続の `onChange` には同じ応答で通知する（記録は実際に保存されており、通知を省くと再描画が漏れる）。これは修正前
から同じで、今回変えていない。変更が要求する処置（読み直し、または `false`）は上の表のとおり確定時に決まる。
`readOverviews` の doc コメントにも明記した。

したがって第1版から第2版で残る挙動の差は「応答を取り込んだ後に来た要求は相乗りせず自分で読む」だけである。

#### 呼出し箇所の確認（限定的）

- `controller.mjs`: 該当の refresh 部分までは読めていない（検索ツールがなく、1〜858 行を読んだ範囲に無かった）。
  根拠は既存テストの抽出実行である。`refreshOverviews` は `FS`・`herald`・`applySeasonRecord`・`readOverviews`・
  `conquestEnabled`・`invalidate` だけを束縛して動くので、その `onChange` が同期的に世界やクライアントを
  差し替える経路は `applySeasonRecord` を直接呼ぶ場合に限られる。実際に呼んでいるかは未確認。
- `app.mjs`: `loadOverviews(herald)` の中身は読めていない。
- このため「現在の呼出し側は配信中に世界を変えない」とは主張しない。第2版は呼出し側の書き方に依存せず、
  上の表の規則で扱う。

### 2. `focus()` が overview を読むと queue の走査に再入する

`pump` は `focus()` を呼び、`focus()` が `readOverviews` を呼ぶと `pump` に戻る。`focus()` が毎回読む場合、
スタックが尽きるまで再帰していた（`RangeError` は握りつぶされるので気づきにくい）。

修正: 走査中の再入は何もせず戻る。外側の走査が、入れ子の要求が積んだ job も並べ替えて開始する。
あわせて `rebase` を `focus()` の後に移した（`focus()` の後の世界で並べる）。

## 調べて、欠陥ではなかったもの

- クライアント／形式の切替え、ring の縮小と再拡張、同一 extent の頻繁な poll、無効な応答、保存時の例外:
  既存実装と既存テストのとおりに動く（机上確認）。
- 応答が返らない読取り: `herald.mjs` の `get` が 12 秒で打ち切るので、枠は解放される
  （`AbortSignal.timeout` がある環境に限る）。

## 残っている論点（未修正）

- **件数が変わり続ける間の飢餓。** 応答待ち中に extent のどれか（他の ring の件数を含む）が変わると、
  その応答は捨てて読み直す。poll の間隔より応答が遅く、かつ poll のたびに件数が変わる状況では、どの ring も
  保存されない。ring 単位の比較にすれば解消するが、既存テスト「changed extent or counts retry …」が
  extent 全体での読み直しを固定しており、季節の取り違えを防ぐ役目も兼ねている可能性があるため、変えていない。
  判断が要る。
- **切替え前のクライアントの読取りも 4 件の枠を使う。** 既存の設計どおり。旧クライアントが応答しない場合、
  新クライアントの開始はタイムアウトまで遅れる。
- `rings` に反復できない値を渡すと、同期的に例外になる（Promise の拒否ではない）。呼び出し側は配列を渡している。

## 不足している純粋テスト

- 上の飢餓の再現（件数が毎回変わる poll と遅い応答）。期待値が設計判断に依存するので書いていない。
- 世界が一時的に `null` になる場合（季節記録の欠落）に、飛行中の job が `false` で確定すること。
- 切替え後に旧クライアントの応答が遅れて戻る間、枠の合計が 4 を超えないこと（現行テストは結果だけを見ている）。

## 参照した資料

`docs/integration/CODEX-LARGE-WORLD-CHART-20261109.md`（第1版の時点では場所が分からず未読。第2版で読んだ）。
同資料の「newer season read rebases pending work and retries stale in-flight reads」「Equivalent unchanged
extent/count snapshots are accepted」は第2版の確定規則と矛盾しない。extent 全体での読み直しは同資料の記述どおり
維持している。
