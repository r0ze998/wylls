# ④から⑫へ渡す受領記録の整合性

基準: 統合候補 d0e96d5394d88decf878676f37bc3782654d1045。

## 修正

④の Settle と Raid は本文にも隊商の owner・seq と slot を持つ。従来の⑫は外側の subject と slot のみを使い、本文との不一致を検出しなかった。破損・取り違えた入力では、別の隊商の結果や未確定の slot を、外側の隊商の確定済み事実として変換できた。実チェーンでの被害や④が通常この不一致を生成することを示したものではない。

本文の完全精度の owner と seq を subject に、本文 slot を外側 slot に照合する。不一致・欠落・精度を失った owner は理由付きで保留し、identity_alias を含む事実を一件も渡さない。負の slot・鐘、不正な観測鐘も保留する。送出の seq は null 等を数値へ暗黙変換しない。

正常な記録のID・数量・確定条件・APIは変えない。保留した記録は修正された正しい入力で再取得できる。これは署名や出典を認証する機能ではなく、既存の呼び出し元の確定性・世界の宣言は引き続き必要。

## 検証

新規 receipt-integrity-keyfree.test.mjs: 20件。変更前は正常系等5件成功、15件で誤受理を再現。変更後20件成功。

既存 adapters-canonical.test.mjs と adapters-ws13-canonical.test.mjs を合わせて39件中38成功・1省略。省略は実runexec SQLite未指定のケースで、成功扱いにしていない。既存④出力fixture4シナリオはすべて維持。

実行:

    node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test --test-reporter=tap workstreams/12-memory/test/receipt-integrity-keyfree.test.mjs workstreams/12-memory/test/adapters-canonical.test.mjs workstreams/12-memory/test/adapters-ws13-canonical.test.mjs

Node v23.11.0。固定データ・ホストのみ。対象のimportを事前に確認し、暗号鍵の生成・導出・署名は実行していない。全体試験・署名付きfixture・実チェーン・CI・push・deployは実行していない。
