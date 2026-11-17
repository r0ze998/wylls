# 現行ソースのネイティブビルド証跡（Claude, 2026-11-17）

秘密情報なし。本書は coordinator が提供した証跡の記録のみで、本書作成時に Claude は何も実行していない（ビルド・テスト・起動・ledger/ソース変更・commit・push なし）。

## 成果の範囲
**現行ソースから実行ファイルを用意しただけ。** ワールド起動、Join、ゲームプレイ、UI のライブ確認、MCP、completion 1–20 のいずれも本書は示さない。

## ソース
- source `1464a4f2eab33cd076c1ed3c21de003f7ba5f5d9`
- ビルド後、export 内の Git blob/mode 9036 件を再照合し、不一致 0。

## ビルド条件（全段共通）
- `cargo` offline・`--locked`・`-j2`、toolchain 1.95.0、target `aarch64-apple-darwin` を明示。
- 段ごとに別の新規 target ディレクトリ、feature も段ごとに分離。
- 上限: 合計 4 GiB / 空き容量 21 GiB 以上 / 1 回 30 分 / ログ 110 MiB。

## 結果
| 段 | バイナリ | features | 所要 | SHA256 |
|---|---|---|---|---|
| herald | `frontier-herald` | default + `land-preview` | 137.029 秒 | `194b0499f56ea7ec549f7da9870a14638ed6d6336c91a319f0f4dbb21c7b8a1d` |
| natural | `localnet-natural-play` | `localnet-expedition-play`, `localnet-land-play` | 216.705 秒 | `ff99700f3027b6a744840c7f268d593b4180000071bd853c75f3d76cd3527e15` |
| expedition | `localnet-expedition-play` | `localnet-expedition-play` | 214.538 秒 | `5bcc4c181e62f6a2d0fe06da2c4a28066051e9fa2b8003ff1e8a4e7eb09b3701` |

- 3 段とも exit 0、監視エラー 0、シグナル 0。
- target 外の witness は変化なし。
- 各段の後に `ps` で同一プロセスグループの残存なしを確認。
- 最終: 合計 2651267072 バイト、最小空き容量 50432233472 バイト。

## 中断と再試行
- herald の初回試行は接続断の前後で中断し、最終報告なし。
- 残存プロセスがないことを確認してから、通常の承認を経て再試行し成功。
- 初回試行の成果物は削除せず保存。

## 残るリスク（隠さない）
- 監視はポーリングのため、ポーリング間隔の間に上限を超える可能性がある。
- 監視ドライバ自体が死んだ場合、その後は上限が強制されない。
- 孤児プロセスが残るリスクは `ps` 確認で低くしたが、ゼロとは言えない。
- 停止を絶対に保証するものではない。

## 既存の成果物（本件では再ビルドしていない）
プログラム `.so` と keeper 3 種を再利用する根拠は既存文書による。本件で新たにビルドしたものではない:
- `CLAUDE-CANONICAL-CANDIDATE-20261116.md`
- `CLAUDE-RELEASE-EVIDENCE-20261116.md`（§3 Source ↔ binary）
