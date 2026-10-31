# 選定方式の比較：Solana の NFT 方式 3 候補（2026-10-31）

対象：「NFT = 住民アカウントの所有権」を、**名前・画像・メタデータの一致ではなく、正しいプログラム・collection・asset ID・現在の保有者**で検証できる方式。公式資料とプログラムのソースで確認した範囲だけを書き、未確認は未確認と記します。価格・発行数・販売方法・ロイヤリティはここでは決めません。

## 0. 結論（試作で選定した方式と、選定しなかった理由）

**Metaplex Core は試作の選定方式であり、本線採用は未決（UNDECIDED U18）。**

| 候補 | 試作での扱い |
|---|---|
| **A. Metaplex Core**（`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`） | **採用（模擬）。** 1 アカウント＝1 資産で、`owner` と「collection 所属」が同じアカウントの先頭にある。所属は `update_authority = Collection(address)` の 1 判定。検証に必要な読み取りが 1 アカウント（＋collection 1 回）で済み、プログラム側の prologue にも載せやすい |
| B. Token Metadata（legacy / pNFT）（`metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`） | 不採用。保有者は SPL トークン口座（amount 1）、所属は Metadata PDA の `collection.{key, verified}`、pNFT ならさらに TokenRecord。読むアカウントが 3〜4 に分かれ、`verified` の確認漏れが典型的な偽物の抜け道。公式も新規は Core を推奨 |
| C. Token-2022 拡張（`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`） | 不採用（第 2 候補）。Metadata / Group / Member 拡張で mint 自体に所属を書ける。所属確認は「group と member の mint が**互いを指す**こと」の相互判定。保有者はトークン口座。Metaplex 以外に依存せず済む利点はあるが、ウォレット・マーケットの対応と、所有権検査を 2 アカウント（mint + token account）で行う手間が増える |
| （参考）Bubblegum 圧縮 NFT（`BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY`） | 対象外。保有者は Merkle 木の葉で、現在の保有者を知るには DAS インデクサの proof が要る（公式: 「Compressed NFTs only exist in the context of a Merkle Tree」）。ログイン・操作権限の判定をインデクサの鮮度に預けることになるので、本件の「操作時点で保有者を確認する」要件に合わない |

## 1. 検証に使う事実（公式資料・ソースの引用）

### A. Metaplex Core

- アカウント構造（`programs/mpl-core/src/state/asset.rs`）:
  `AssetV1 { key: Key /*1*/, owner: Pubkey /*32*/, update_authority: UpdateAuthority /*33*/, name: String, uri: String, seq: Option<u64> }`
- `UpdateAuthority`（`state/update_authority.rs`）: `None`（immutable）、`Address(Pubkey)`、`Collection(Pubkey)`（「Authority delegated to a collection」）。
- 公式ドキュメント（What is an Asset）: update authority の型が `Collection` のとき「The asset belongs to the collection at the given address」。JS ヘルパ `collectionAddress()` は `updateAuthority.type === 'Collection'` のときだけアドレスを返す（`clients/js/src/helpers/state.ts`）。
- 譲渡（docs/core/transfer）: 「Only the current owner (or an authorized Transfer Delegate) can initiate a transfer」「Transfer only changes ownership」「Transfer, Burn, and Freeze Delegates are revoked after a successful transfer」「Frozen Assets cannot be transferred until unfrozen」。
- プラグイン（docs/core/plugins）: Owner-managed（Transfer/Freeze/Burn Delegate）、Authority-managed（Attributes, Royalties, Update Delegate）、Permanent（作成時のみ）。外部プラグイン Oracle は `create / transfer / burn / update` を**拒否**できる（公式表では Can Reject のみ）。Core は Oracle 口座を読むだけで書かない。
- DAS（docs/core/fetch）: `interface: "MplCore"`, `ownership.owner`, `grouping[{group_key: "collection", group_value}]`。インデクサは表示用に使い、**認可は RPC の生アカウント読取**で行う（下記 §2）。

### B. Token Metadata

- `declare_id!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")`（`programs/token-metadata/program/src/lib.rs`）。Metadata PDA seeds は `["metadata", program_id, mint]`（`pda.rs` の `PREFIX = "metadata"`）。
- Collection（docs/token-metadata/collections）: `collection: Option<{key, verified}>`。`verified` は collection の authority（update authority か委任）が署名する Verify で立つ。「Without this check you could be exposing fraudulent NFTs on real collections」。
- 公式の位置づけ: 「Token Metadata is a legacy program … not recommended for new projects」。pNFT はトークン口座が凍結され、譲渡は Token Metadata 経由（RuleSet）。

### C. Token-2022

- 拡張一覧（solana-program.com/docs/token-2022/extensions）: Metadata Pointer / Metadata、Group Pointer / Group、Member Pointer / Member、NonTransferable、Permanent Delegate、Transfer Hook。所属確認は「a client must check that the mint and the member both point to each other」。
- NonTransferable は本件の要件（譲渡可能）に反するので使わない。Permanent Delegate は発行元が任意に動かせる権限で、住民の所有権の意味を弱めるので使わない。

### SIWS（ログイン文面）

- phantom/sign-in-with-solana: `domain`, `address`, `statement`, `uri`, `version`, `chainId`, `nonce`（8 文字以上の英数字）, `issuedAt`（±10 分）, `expirationTime`, `notBefore`, `requestId`, `resources`。検証は `verifySignIn`（`@solana/wallet-standard-util`）が「解析 → 入力と照合 → ABNF で再構築 → 署名検証」。
- Lit Protocol の注意（sol-rpc-conditions）: 「any EDDSA signature that is valid will allow auth」—— 古い取引の署名の流用を防ぐため、domain・nonce・期限を**サーバで**確認する。試作の `auth.mjs` はこの通り、発行した文面と byte 単位で一致する署名だけを受け付け、nonce は 1 回で消費する。

## 2. 認可に使う判定（選定方式 A）

1. アカウントの `owner`（プログラム）が Core プログラム ID である（`WrongProgram`）。
2. 先頭 1 byte が `Key::AssetV1 = 1`（`NotAnAsset`）。
3. `update_authority` が `Collection(期待する collection)`（`NotInCollection`）。同名の別 collection、collection なし（`Address`）はここで落ちる。
4. 保有者＝`owner` フィールド。**操作時点で読み直す**（ログイン時だけでは不十分）。読取のスロットが「最後に確認した保有者変更」より古ければ `StaleRead` として拒否。
5. `name`・`uri`・オフチェーン JSON・collection の名前や画像は認可に使わない（表示のみ）。

**譲渡の経路をプログラムに限る**手段が Core に 2 つある（CONTRACT §10）：Permanent Freeze Delegate＋Permanent Transfer Delegate（公式：作成時のみ追加、譲渡後も失効しない、Permanent Transfer は「forceApprove — can transfer even when frozen」）と、Oracle 外部プラグイン（`transfer` を拒否できる）。試作は前者を模擬した。これが「買い戻しで旧権限が復活しない」保証の根拠で、代わりにマーケットプレイスの通常の譲渡フローと両立しない（U7）。

## 3. 譲渡と委任の関係（A で確かめた挙動）

| 事象 | Core の挙動（公式） | 本設計の帰結 |
|---|---|---|
| 譲渡 | `owner` だけ変わる。Transfer/Burn/Freeze Delegate は失効 | 住民 ID（asset 由来）は不変。ゲームの session 鍵はゲームプログラム側の記録なので**自動では失効しない** → 「session を設定した保有者 = 現在の保有者」を prologue で要求する（INTEGRATION-04.ja.md 案 B） |
| 凍結 | 凍結中は譲渡不可 | 凍結中の操作可否は別途判断（試作は拒否） |
| 焼却 | アカウント消滅 | 住民記録は `gone` として残し、全操作を拒否。再作成しない |

## 4. 先行事例（GitHub・公式ガイド）

- Solana 公式ガイド「NFTs in games」: NFT の mint を seed にした PDA（`["player", mint]`）に状態を置くと「state travels with the NFT」。本設計の「住民 ID = asset 由来」はこの形。
- phantom/sign-in-with-solana（158★）、Crossmint/solana-auth（archived）、Web3Auth/sign-in-with-solana: いずれも「nonce 付き文面を署名 → サーバ検証 → セッション」。NFT 保有は別途 RPC/DAS で確認する構成。
- thirdweb 系の NFT-gated サイト例（複数、各 1〜15★）: 多くが DAS/Moralis API の結果（名前・collection 文字列）で判定しており、本件が避ける「メタデータ一致で認可」の形。反面教師として参照。
- Metaplex 公式 CLI / OneKey ウォレット: `asset.updateAuthority.type === 'Collection'` で collection を解決（本試作と同じ判定）。
