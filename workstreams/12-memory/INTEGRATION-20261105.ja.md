# 12 記憶試作の隔離統合記録

- 受領原本: `wylls-12-memory-73a3e984.zip`、SHA-256 `145d41588c972fbce773334eaf855d8c7336f5ef5f06ae4ab16bc22991870e0d`
- 原本の Git HEAD: `73a3e98412a0cf58d0904bc6db24c57cad218a3f`、tree: `1b9806c5692438257caa183bffe02217b0073e4c`
- 受領した41ファイルを `workstreams/12-memory/` にそのまま追加した。既存の `permutation-gateway/citizens/memory/` や本番の入力経路は変更していない。
- この統合候補で `node --test workstreams/12-memory/test/*.test.mjs` は82件通過、失敗0件。

## 接続前に必要な契約

1. 4 の Receipt から、確定性・source/ID・redaction・再生時の重複を保った記憶入力を定義する。現行の EpisodePump は Receipt を直接読まない。holding/vault の実加算量と十分な索引範囲を受け取るまで、未着・未発送・不履行を断定しない。
2. 8 の world/partition 登録、world bell、ID と場所の別名を、正本に結びつける。試作の fixture だけで実際の継続世界の移行を保証しない。
3. 5 と 13 の予算・行動 ID・再起動後の再送防止、および20のNFT譲渡時の記憶の扱いを照合する。これらの最新版は、この統合候補にはまだ入っていない。
4. 記憶の閲覧権、公開要約・エピソード、保管期間と削除、NFT譲渡後の私的記憶の扱いは未決定。既存の公開ファイルへ試作の私的内容を流さない。

この段階では、協定・約束の発言を権限、契約、配送の証拠として扱わず、評判でゲーム内の確定した権利を変えない。実LLM、実チェーン、実プレイヤーデータは未検証。
