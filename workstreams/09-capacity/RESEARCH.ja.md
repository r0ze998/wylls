# 先行するオープンソースの比較（実装の前に調べたこと）

2026-10-30、GitHub のコード検索で調べました。この session の GitHub 接続は `r0ze998/wylls` に限られているため、他のリポジトリはファイルを開けず、**検索結果の抜粋（型・フィールド・説明文）だけ**を読んでいます。抜粋に無い挙動は推測として書きます。

| 対象 | 何を見たか | 学んだこと | ⑨ での扱い |
|---|---|---|---|
| **Eternum**（BibliothecaDAO/eternum、Cairo/Dojo） | `ResourceProduction { building_count, production_rate, output_amount_left, last_settled_at }`、`ProductionRecipe { simple_inputs, complex_inputs, … }`、fact-models の説明「Production pays its per-second rate for elapsed seconds after last_settled_at, while at least one production building exists」 | 生産は**前払いの出力予算**（`output_amount_left`）を秒単位の率で消化し、触ったときに精算する。入力は予算を作るときに消える（抜粋からの推測） | 採用：**入力は開始時に固定、出力は時刻の閉じた式**（`Job::out_at`）。予算の考え方は `limit`（出力上限・材料・期間の最小）に当たる。Wylls の `Holding::settle` も同じ遅延精算なので相性が良い |
| **Star Atlas の crafting**（staratlasmeta/star-atlas-decoders） | 命令 `AddRecipeIngredient`（`crafting_process`, `crafting_facility`, `token_from`）、`StartCraftingProcess`、`StopCraftingProcess`、`ClaimRecipeOutput`（`token_from`→`token_to`）、`Recipe` の `duration`, `usage_count`, `usage_limit`、SAGE の `CraftingInstance { authority, crafting_process }` | 施設（facility）と加工（process）を分け、**材料は加工ごとの口座に預ける**。開始・停止・受取が別命令。レシピに使用回数の上限がある | 採用：**施設 ≠ 加工**（Pool と Job）、**加工ごとのホッパーと出力の置き場**、開始前の投入・停止（Cancel）・受取（Claim）の分離。施設の同時実行数は、Wylls では工房の棟数（`lent`）で表す |
| **ERC-4907**（chiru-labs/ERC721A の `ERC4907A`） | `setUser(tokenId, user, expires)`、`userOf` は `userExpires >= block.timestamp` のときだけ user を返す | **所有者と利用者を分け、期限で自然に切れる**。所有権の移転で利用者が消える | 採用：所有者（A）と利用者（B）の分離、許可の期間 `[from, until)`。所有権の移転（占領）で**世代が変わり、許可・予約が無効**（`FacilityId.gen`） |
| **Cardinal token-manager**（holaplex/indexer の取り込み処理から） | `invalidation_type`、`use_invalidator_total_usages`、`use_authority`、`state_changed_at` | 貸し出した物の**無効化の種類**（返す・無効にする・解放する）と、**使用回数の上限**を明示的な設定として持つ | 採用：無効化のときの扱いを**方針として明示し切り替え可能**にする（`LossPolicy`、`RevokePolicy`）。使用回数の上限は、出力総量の上限 `max_output` と同時枠の上限 `max_units` にした |

## 比べて選ばなかったこと

- **NFT を貸す形（4907／Cardinal）そのもの。** 施設は Holding（コアの口座）で、札（token）にしていない。段階2の「使用権の札」は ② の Grant の範囲なので、⑨ は施設の利用に限った `Grant` を持ち、② が来たら写す（契約 §8）。
- **使用回数（Star Atlas の usage_limit、設計 20 の「1日○回」）。** Wylls のコードの工房は回数ではなく**連続変換**（兵器 4/時/棟）なので、「回」ではなく「棟 × 時間」で貸す。設計文書との食い違いとして README に記録した。
- **共有の汎用台帳。** Star Atlas は預かりをトークン口座で持つが、Wylls ではそれは ⑩ の担当。⑨ は `Custody` trait（6 呼び出し）だけを決めた。

## 未確認

- 各プロジェクトの実際の挙動（抜粋に無い部分）、特に Star Atlas の停止時の材料の扱い、Eternum の予算の作り方。リポジトリへの読み取りが許されれば確かめられる。
