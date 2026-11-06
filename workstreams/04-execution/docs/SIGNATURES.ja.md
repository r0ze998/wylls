# 署名の要件：誰が SendCaravan に署名できるか

前回の文書には「他人への配送には相手の wallet 署名が必要」と読める記述があった。**これは誤り**である。必要なのは**送信者本人（依頼者の Citizen の wallet）の署名**で、受取人は署名しない。以下は、命令の実装、アカウントの制約、テストのソースに基づく確認である。

**検証の範囲**：この確認はコードとテストのソースを読んだ結果である。program の LiteSVM テスト（`permutation-frontier/svm-tests`）は、この環境では**実行していない**。SBF の program をビルドするための Solana の platform-tools（`scripts/build-frontier.sh` は `~/.local/share/solana/install/active_release` を前提にする）が無いためである。

## 1. 根拠

| 事実 | 根拠（基準 commit `4cd901de`） |
|---|---|
| 署名者は Citizen の `WALLET` か `SESSION` のどちらか。`actor == WALLET` なら `by_session = false`。そうでなければ `SESSION` と一致し、`SESSION_EXPIRY` より前でなければ拒否（`Auth`、`SessionExpired`） | `frontier-abi/src/prologue.rs:1120-1131` |
| SendCaravan のアカウントは `[src w] [src_province r] [dst r] [caravan w] [system] [path_province w ×1..4]`。**宛先（dst）は読み取り専用で、署名者ではない** | S1-1B 契約 §3 の表、`permutation-frontier/src/proc/caravan.rs:685` |
| 送り元は依頼者のもの（`s.owner != citizen` なら `NotOwner`） | `proc/caravan.rs:705-707` |
| **宛先が依頼者のものでなく、署名者が session key なら `WalletRequired`** | `proc/caravan.rs:726-729`：`if t.owner != citizen.key.to_bytes() && pl.pc.by_session { return Err(cq(CqError::WalletRequired)); }` |
| 宛先の検査は、存在すること、生きていること、kind・世代が一致することだけ。宛先の所有者の同意は求めない | `named_place(…)`、`proc/caravan.rs:713-721` |
| session key は、wallet が署名する `SetSession` でだけ設定・回収できる | `docs/agent-wallet/DESIGN.md` §「Enforced on chain」、`permutation-frontier/src/proc/citizen.rs` |
| テスト：session key による他人宛ては `WalletRequired`。session key による自分の場所の間の送付は着地する。**wallet による他人（R）宛ては着地する（R は署名しない）** | `permutation-frontier/svm-tests/tests/caravan.rs:606-664` `g13_s1_send_caravan_refusals`（「A send to another player by the session key」「The session key may send between the actor's own places」「The wallet may send to another player」） |

## 2. 三つの場合

| 場合 | 署名者 | できること | 制約 |
|---|---|---|---|
| **所有者本人による送信** | 依頼者の wallet | 自分の場所の間の送付。**他人の場所への送付**も可（受取人の署名は不要） | 送り元が自分のものであること。seq、手数料、荷、経路、宛先の世代の検査。holding が送り元なら capture lock と finality |
| **委任 agent による送信**（`SetSession` で渡した session key。agent wallet の agent key を含む） | session key | **自分の場所の間の送付だけ** | 他人宛ては chain が `WalletRequired` で拒否する。有効期限（`SESSION_EXPIRY`）。wallet の `SetSession` でいつでも回収される |
| **他人を宛先とする送信** | 送信者の wallet が必須 | 送信者の wallet が署名すれば成立する | 受取人は署名しない。受取人の同意も拒否も chain は求めない。宛先の世代が変われば settle で失われる（S1-1B §3.4） |

## 3. 混同してはいけない点

1. **「wallet の署名が必要」は送信者の wallet のことで、受取人のことではない。** 受取人の同意が必要な仕組みは、現行の chain には無い。
2. **session・agent の委任では、他人宛てが実行できない。** これは送信者の権限が足りないのではなく、委任された鍵の範囲を chain が狭めているためである（盗まれた session key では、被害者自身の場所の間でしか物を動かせない。S1-1B §3.3）。
3. **session key には、命令ごとの範囲の指定が無い。** 同じ session key で Depart（進軍）、RaidCaravan などの session 可の命令にも署名できる。「④は物流しか自動化しない」（`policy::AUTOMATABLE`）、agent wallet の許可リスト（`ACTION_GROUPS`）、`AgentKeyDirect` は**どれも off-chain の制限**であり、session key の seed を持つ者は RPC へ直接送ることで回避できる（`docs/agent-wallet/DESIGN.md` §「Enforced by the operator's server only」）。chain 上での範囲の制限は提案に留める（[patches](../patches/README.ja.md) P6）。

## 4. ④の実行器での扱い

- 実行器が使う鍵は**委任された session key** を前提にする。他人宛ての run は、chain が `WalletRequired` で拒否する。拒否された署名済みのバイト列が有効期間を過ぎるまで待ってから、run を `FacilityConfirmed` に戻して保留にする（`WalletRequired`）。産出物は在庫の場所に残る。
- そこから先は人の操作である。依頼者が自分の wallet で SendCaravan に署名するか、run を取り消す。実行器は送信者本人の wallet 鍵を持たない。
- テスト：`send_to_another_player_is_held_for_the_wallet`（MOCK。模擬正本は `proc/caravan.rs:726` と同じ条件で拒否する。ただし、模擬正本は「宛先の所有者 ≠ 送信者」だけを見ており、session と wallet を区別しない。**実行器は常に session として扱われる**前提である）。
