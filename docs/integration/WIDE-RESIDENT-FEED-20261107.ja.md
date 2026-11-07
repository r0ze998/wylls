# ワイドゲームとResidentFeedの統合

## 版と対象

基準は455f03afbcc844bae2555b522cf32fec3e76efb3。20のGitHub先端72d841738fede003d8f540ef5b74eb30f4b7c3dfを競合なくmergeしました。552c1d14のResidentFeed、9e9fe7afのledger tip確認、その後の文書2件を含みます。共通の3ad0bcdb以前は再適用していません。マップ・UI・ワイド地形のソースは455f03afから変えていません。

4 r4/r5 bundleは取得できていません。4の31項目照合器は未統合です。4 r5の申告基準552c1d14は今回の20の祖先なので、本体を取得したら共通変更を重ねずに追加分を統合できます。

## 実装と補強

- localnetの住民プログラムfeedをゲーム履歴の後で読み、共通seq・署名・範囲・取得元・取得後のtipをV28へ渡す入力を統合しました。
- 20の履歴規則を保持しました。取引内で決まるV28所見は確定FAILに数え、履歴に依存するResidentOldAuthorityは除外します。追加の履歴試験で両方を確認しました。
- 補強: feed.programがpolicyのresident_programと異なる場合は、holderをUNVERIFIABLEにします。
- 補強: 記録上の権限が一致していてもfeedにgap等があれば、現在のholderを確かめたことにせずUNVERIFIABLEを残します。

## この木での検証

鍵ペア生成・秘密鍵導出・署名は実行していません。公開PDA/with_seed計算を使う固定データ試験を名前で指定しました。

- ResidentFeed 2/2
- V28 7/7（補強2件を含む）
- history 16/16（V28の履歴判定も含む）
- V26 5/5
- V27 7/7
- frontier-node全workspaceのall-targets型検査: 成功。試験の実行ではありません。
- verifyのclippy（tests含む、警告をエラー）: 成功。

前の統合報告で再実行待ちだったhistory試験も今回16/16で確認しました。旧march-synthのV11配置違反6件は、その既知FAILを隠さず対照に固定しています。

## 未完了

- 実チェーン、署名付き取引、本番配備は未実行。
- ResidentAct内側の命令効果の再生は未実装。NFT操作のある季全体がPASSする完成版ではありません。
- 保存物のfeed_seqを使う読み出しは未実装。19の決定はプログラムごとに一本＋元台帳seqを保存する方式です。公開RPCを完全とは扱いません。
- 空のlocal feedは既存入力保全の方針でunknownのままです。安全側に倒れ、20のコメントにある『空でもledger_feed』へ自動で格上げしていません。
- 4 r4/r5本体と31項目照合器は未受領。NFT賞金成功や旧所有者の荷車受付まで完成したとは扱いません。
