# ⑲巻き戻り対策の独立照合と安全統合

## 実体照合

- 基点: 365596d1b3fe93e426eb69e8755bef35aa164ea1。
- 添付bundle: ws19-rewind-on-7d077fc6.bundle、10,749 bytes。
- SHA-256: d5780f3130b77703f44ba2aed68570ac31587925d6aa72095ea25983521a6f69。
- patch SHA-256: 56e317a3dd7667563f0a5316dbbf960ddf6f7673149bcf2f704f2da40cfef762。
- HEAD: 3c664a61903f0522282f86f086a895b7dc042646。
- tree: e088856a58f6e4966947c111446cfb2335723e06。
- 前提7d077fc6を保持するrepoでbundle verifyと復元成功。全値が申告と一致。

## 統合内容

- nodeのrunId、ledgerBytes、取引数、各archive末尾の元seq/署名の照合を導入。
- ノード読取失敗、末尾置換、台帳縮小は確認不能として返す。
- live読取り前後の台帳縮小を検知する。
- 独立確認で、statusが両方読めない場合にNone同士を等しいとして扱える経路があったため、前後どちらかのstatusまたはrunIdが無い場合をUnknownにした。
- 4ファイルの競合を解消。既存archive安全制限を保持し、ノード照合成功でもUnknownのままとする。元ledger seq復元と観測的な末尾照合は利用できる。
- join JSONのwhole:false、archive_consistentによる構造判定の分離を維持。

## 同じ統合木での試験

固定バイト署名欄、固定Address、未署名Transaction、HTTP模擬ノードを使い、各試験名を完全一致指定。鍵ペア生成・秘密鍵導出・署名なし。

- findex ledger: 15件通過。上流14件＋既存の構造整合と完全性を分ける試験。
- verify ledger_history: 6件通過。上流5件＋status読取失敗の独立試験（前後両方/前だけ/後だけの3条件）。
- verify resident_ledger: 3件通過。
- 合計24件。archive-onlyと照合成功時の期待値を、上流のLedgerFeedからUnknownへ意図的に厳しく変更した。
- workspace all-targets型検査とverify/findex tests clippy通過。コンパイルのみ。

## 未解決・未取得

- 末尾照合は原子的な同時snapshotではない。照合直後のrollback、末尾を復元した内部改変、照合の間の状態変更などの一般的証明にはならない。
- 稼働中heraldの常時巻き戻り検出は未実装。次の再開または検証まで気づかない場合がある。
- 記録時サイズが無いarchiveではサイズ比較を行えない。末尾検査だけで完全とは扱わない。
- archiveのみでも構造上整合する古い記録は残り得る。Unknown制限は解除していない。
- 本物のlocalnet/herald常時稼働、実チェーン、署名付きE2Eは未確認。
- ④のscan応答案と独立試験、④r4/r5の31項目修正は本体未受領・未統合。
- 別枝の広域Open87088006は本枝には未合流。

main・本番を変更せず、[skip ci]付き保全pushのみ。
