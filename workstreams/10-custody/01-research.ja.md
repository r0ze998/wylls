# 01 既存のオープンソースの方式の比較

手を動かす前に、所有者を変えずに預ける・使わせる・予約する仕組みを公開コードで比べました（2026-10-30 に読んだ。コードの読み取りで、実行はしていない）。

| 対象 | 何を見たか | 取り入れたこと | 取り入れなかったこと |
|---|---|---|---|
| **TigerBeetle の二段階の振替**（[docs/coding/two-phase-transfers.md](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/coding/two-phase-transfers.md)） | 予約（pending）で残高の一部を確保し、post（全部・一部）か void で一度だけ解決。timeout で自動的に解放。予約の時点で上限を検査するので、post・void が不変条件を破らない | **予約と実物の移動を分ける**（注文＝予約、発送・消費＝post）。予約時に「利用可能」を検査。期限で予約が**番人なしに**消える。一部の post（注文の分割発送） | 予約を別の不変レコードにして解決を新レコードにする形（口座数と rent が増える）。区画の中の固定枠にした |
| **SPL Token の委任と凍結**（[solana-program/token processor.rs](https://github.com/solana-program/token/blob/main/program/src/processor.rs)） | `Approve` が `delegate` と `delegated_amount` を上書き、`Transfer` で委任者なら残量を減らし 0 で委任を消す。`Revoke` は所有者だけ。`Frozen` の口座は Approve・Transfer・Revoke を拒否 | 注文の受け手は**量の範囲内だけ**、使い切ると枠が空く。取消しは所有者。凍結（押収後の区画）ではすべて拒否 | 委任が口座に一つだけ（上書き）。運搬と利用を同時に別の人へ許す必要があるので、枠を4つにした |
| **EVE Frontier の Storage Unit**（[evefrontier/world-contracts](https://github.com/evefrontier/world-contracts) `contracts/world/sources/assemblies/storage_unit.move`、[公式文書](https://docs.evefrontier.com/smart-assemblies/storage-unit)） | 施設の持ち主の主在庫と、**他の人ごとの在庫**（キャラクターの OwnerCap で鍵付け）を同じ施設の中で分ける。持ち主の拡張だけが他人の在庫へ入れられる。オフライン中は在庫は残るが動かせない。**撤去（unanchor）では他人の在庫も含めて全部焼く** | 「施設の中の、人ごとの区画」という形（Lot ＝倉×所有者×資源）。持ち主の一般在庫と口座を分ける。動かせない状態（凍結）を、消すことと区別する | 撤去で他人の物を焼く挙動：**この実装は区画のある倉を閉じさせない**（CloseVault を拒否）。失う場合は採用ルールが決める押収だけで、記録を残す |
| **Eternum の資源の承認と受け取り**（[eternum resource_systems.cairo](https://github.com/frontboat/eternum-npm/blob/main/contracts/game/src/systems/resources/contracts/resource_systems.cairo)、BibliothecaDAO/eternum の写し） | `approve` が（持ち主、相手、資源）ごとの上限を上書き、`pickup` で相手が自分の建物へ引き取り上限を減らす。送り（`send`）は受け手の同意なし、到着は arrivals として後で降ろす | 資源ごと・相手ごとの上限。到着を後で精算する形は S1 の隊商と同じ | 「送られた物は受け手のもの」：この実装の保管品は届いても所有者のまま。受け手の同意なしの送り：区画は保管者が開いたものにしか入らない（容量の約束が同意） |

## 結論として採った形

- **会計区分は口座で分ける**（EVE の人ごとの在庫）。倉の `STORES` と区画の `HELD` は別の欄で、S1 の既存命令は `STORES` しか読まない。名前だけ変えるのではなく、保管者が使う命令の経路がそもそも区画に届かない。
- **予約と消費を分ける**（TigerBeetle）。注文で確保し、受け手の発送・消費で実際に動く。予約の合計は保管量を超えない。
- **範囲と期限のある委任**（SPL Token、Eternum の allowance）。受け手・量・期限・宛先または目的を注文に書く。
- **凍結と消失を区別する**（EVE のオフライン）。押収された倉の区画は、照合まで「凍結」として残り、照合で「損失確定」になる。
- 再送の防止は既存の S1 と同じ（SendCaravan の `seq = Citizen.CARAVANS`）に揃え、注文には区画の `NONCE` を足した。
