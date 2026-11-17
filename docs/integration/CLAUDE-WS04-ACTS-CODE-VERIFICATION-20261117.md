# WS04 acts_code 検証報告(2026-11-17)

## 位置づけ

この報告の実行証跡はコーディネーターから提供されたものです。本書の作成者はテストを実行していません。ソースコードは変更していません。main・CI・デプロイへの操作もありません。

## 実行内容(承認済み)

```
CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 \
cargo test --offline --locked -j1 --target aarch64-apple-darwin \
  --test acts_code -- --test-threads=1
```

- target/tmp は、この実行専用に新しく用意したものです。

## 結果

| 項目 | 値 |
|---|---|
| コンパイル | 23.70s |
| テスト | 2/2 passed(failed 0 / ignored 0 / filtered 0) |
| ドライバ所要時間 | 24.227s |
| 終了後のプロセスグループ残存 | なし(ps で確認) |
| target 最大サイズ | 176721920 bytes |
| 最小空き容量 | 54357495808 bytes |
| ログサイズ | 2823 bytes |
| ガードの errors / stops / signals | 0 / 0 / 0 |

- SQLite ファイル 3 個が作成されました。作成先は新しい `target/aarch64-apple-darwin/tmp/runexec-tests` 配下だけです。
- 旧 crate target の witness に変化はありません。

## 検証範囲

- テストでは実際の `acts::refresh` / store / receipt と `ScriptFateReader` を使いました。実際の gateway・world・鍵・ネットワークは呼び出していません。
- `common` 内の未使用の制限付きヘルパーはコンパイルされますが、実行はされません。
- 既に検証済みの ⑬ consumer 4/4 と合わせると、契約の両端を確認できたことになります。
- ただし、実 HTTP 結合と常駐運用全体は検証していません。

## 既知事項

- 以前の「missing code 伝播ギャップ」は、現在採用中のブランチで解消済みです。
- wallet の `duplicateOf` / sent のセマンティクスは未採用のままです。

## 監視の上限と限界

- 上限:10 分 / target 4GiB / 空き容量 21GiB / ログ 110MiB。
- 一般論として、ドライバ自体が生き残ることや、捕捉されなかった子孫プロセスが完全に停止することは保証できません。今回の実行については、実際に終了したことを確認しています。

## 公開上の配慮

本書には次の情報を含めていません。

- 個人パス
- run ID
- PID
- セッション ID
- 完全なログ

## 追補:ネイティブプロセス/JSON クライアント/status port の接続確認

この追補の実行証跡も、通常の承認を経てコーディネーターから提供されたものです。本書の作成者はコマンドを実行していません。コード変更・コミット・公開はありません。

### 実行内容

- コンパイル済みの runexec を使いました。
- 実際の `createActsClient` を使いました(既定の execFile、gatewayPort なし、timeout 2500ms)。
- `ws04ActsStatusPort` を経由して 4 ケースを実行し、合計 315ms でした。

### 結果

| ケース | 結果 |
|---|---|
| 着地済み receipt の重複 | failed / signature なし |
| 通常の pending | pending / sigA |
| failed-read を保持したもの | `fromReceipt` による Unqueryable |
| 本当の NoRecord(exit 3) | null |

### データ保全

- 使用したのは、以前の Rust fixture で作成した使い捨ての SQLite DB 3 個だけです。
- `Store::open` はスキーマや WAL に触れることがあります。ただし、3 個すべてで、読み取り専用・immutable で取得した論理 iterdump の SHA256 が実行前後で一致しました。
- integrity_check は 3/3 で ok でした。WAL は残っていませんでした。
- ps で確認したところ、runexec のプロセスは残っていませんでした。
- ハーネスはローカル専用で、個人パスが固定されています。公開していません。

### 検証範囲

- 確認できたもの:ネイティブプロセス、JSON クライアント、status port の接続。
- 未検証のもの:HTTP、world、send、常駐運用全体。
- 本追補にも、個人パス・run ID・PID・セッション ID・完全なログは含めていません。
