# 12 → 13 公開証拠の読み取り接続候補

`resident/ports/ws12-public-evidence.mjs` は、12の `knowledge` を**公開記録だけ**で読み、相手に関する行を `epistemic` と出典ID付きで返す。13の `MemoryPort`（`append/recall/all`）は実装しないため、現在の住民の信頼値、候補点数、判断、権限、予算、送信には影響しない。公開以外の `parties` と `nation` の記録は読まない。

13の財布アドレスを12の短いprincipal/tagと同じものとはみなさない。12の継続世界IDが無ければ `world_unverified`、呼び出し側が4・8の正本から相手のprincipal、対応の出典、世界bellを供給できないときは `identity_unverified` で空の行を返す。現段階の試験はfixtureの対応表を用いるだけで、実際の本人確認を検証したものではない。12のjournalへ投入する実Receipt、確定性、全経路のcoverage、所有者区間、加算量も未接続である。

13の模擬掲示板の`lapsed`や`not-returned`、`returned-late`を12の確定した不履行として入力しない。証拠不足は12の`unknown`のまま表示する。十分な索引が短不足を証明しても、この接続口は13の`broken`エピソードを自動作成しない。私的記憶のNFT譲渡や公開範囲もここでは決めない。

`node --test workstreams/13-citizens/test/ws12-public-evidence.test.mjs` で、対応表欠落、未確定事象、確定した公開短不足、遅れて観測した索引、私的・国別記録の非表示を確認する。
