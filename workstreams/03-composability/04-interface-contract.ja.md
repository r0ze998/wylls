# 04 権利を伴う機能を呼ぶ公開インターフェース（契約案）

**位置づけ。** §1–§2 は今のコアに**既にある**公開面の事実。§3–§5 は外部プログラム向けの契約の**案**で、courier がその最小の実装例。②の権利ルール（Grant）は受領していないため、§4 は差し替え前提の仮アダプターとして書く。

## 1. 公開面は Frontier の命令そのもの

外部の作者が呼べるのは ABI v2 の命令（[02](02-instruction-matrix.ja.md)）で、別の入口はない。CPI で呼ぶ場合も、Frontier は口座表・署名・所有者・アドレス・状態・規則をトップレベルと同じく検査する。`t01` は、courier 経由と直接呼出しで書込先の口座（Citizen、Holding、Vault、Province、Caravan）がバイト単位で一致することを示した。

| 項目 | 今の契約 | 出典 |
|---|---|---|
| 命令の識別 | データ先頭1バイトのタグ。再利用しない | `frontier-abi/src/v2/tags.rs`、M1 契約 §5.5 |
| 入力 | 固定長・LE のデータ（SendCaravan は 65 B）＋ ABI の口座表（数・順序・署名・書込） | `src/v2/ix.rs`、`src/v2/prologue.rs` |
| 出力 | 口座の状態（Caravan は `cv‖owner_tag,seq` に作られる）＋ PS2 記録（`Program data:` 行、CARAVAN_SENT など）。Frontier は return data を返さない | `src/v2/log.rs`、`fclient::log::bodies_from_logs` |
| エラー | `FrontierError` 1–61・99、`CqError` 62–93。CPI 越しも同じ番号 | `src/error.rs`、`src/v2/error.rs` |
| 版 | Season の `PROGRAM_VERSION`（S1 = 4）と `RULESET_HASH`（V3）。ABI の `abi_version` 2。各口座の `LAYOUT_VERSION` 2 | `src/v2/presets.rs`、`vectors/v2/tags.json` |
| 権限 | actor = Citizen の wallet か期限内の session 鍵。payer は署名者で System 所有 | `frontier_abi::prologue::player_prologue` |

## 2. 呼び出し側が自分で確かめるべきこと（Frontier が代わりにしないこと）

| 確認 | Frontier の挙動 | courier の実装 |
|---|---|---|
| 呼び先が本物の Frontier プログラムか | 判定しない（別の id に同じ ELF を置けば同じく動く） | ビルド時の `COURIER_FRONTIER_ID_HEX` と一致し実行可能か（`WrongFrontier`、`t05`：偽 Frontier を CPI の前に拒否） |
| Season がその Frontier のものか | Frontier 自身が owner と PDA を再計算（`BadAddress`） | owner を確認（`WrongFrontier`）。Frontier 所有の偽コピーは Frontier が `BadAddress`（`t05`） |
| 版がビルドした前提と同じか | ruleset は検査（`RulesetMismatch`）、`program_version` は呼び出し側の期待と照合しない | `PROGRAM_VERSION == 4` と `RULESET_HASH == V3` を CPI 前に確認（`FrontierVersion`、`t09`） |
| 自分のインターフェース版 | — | 2バイト目が `IFACE_VERSION`（`InterfaceVersion`、`t09`） |
| 渡すデータの型 | Frontier が `decode`（`BadData`） | 先に `SendCaravan::decode`（`BadInstruction`、`t06`・`t09`） |

## 3. 契約案: 外部プログラムが権利を伴う機能を呼ぶ形

```text
// 呼び出し（courier の命令データ。v1 は SendCaravan のみ）
CapabilityCall v1 = {
  op:            u8         // 0 = 所有者署名, 2 = 委任（§4）
  iface_version: u8 = 1     // 不一致は InterfaceVersion (9001)
  action:        frontier_abi::v2::ix::SendCaravan  // Frontier の wire 形式そのまま（65 B）
}
accounts = [frontier_program] ‖ (op 0: SendCaravan の口座表そのまま
                                 op 2: [cranker s][grant/mandate w][session][purse w] ‖ season, citizen, 以降は SendCaravan の表)

// 前提（ビルド時に固定、実行時に照合）
Expect = { frontier_program_id, program_version: 4, ruleset_hash: RULESET_HASH_V3 }

// 結果
Ok  = { return_data: le32(seq),                       // courier が設定
        caravan: create_with_seed(season_pda, "cv‖owner_tag,seq", frontier_id),
        record: CARAVAN_SENT（Frontier のフレーム内の PS2 記録） }
Err = { layer: Courier  code 9001–9010（下表）
             | Frontier code 1–61, 62–93, 99（ABI の名前で）
             | Runtime  PrivilegeEscalation, ExternalAccountDataModified,
                        ExternalAccountLamportSpend, MaxLoadedAccountsDataSizeExceeded ほか }
```

どの層が拒否したかは、失敗したプログラムのログ行（`Program <id> failed: custom program error: 0x…`）で区別できる（courier-tests の `assert_courier` と `assert_code` がこの区別を確認している）。

| courier の code | 名前 | 意味 |
|---|---|---|
| 9001 | InterfaceVersion | 2バイト目が 1 でない |
| 9002 | WrongFrontier | 呼び先・Season・Citizen が想定の Frontier のものでない |
| 9003 | FrontierVersion | Season の program_version / ruleset が想定と違う |
| 9004 | BadInstruction | op が不明、または SendCaravan として解読できない |
| 9005 | MandateMismatch | 委任口座が courier のものでない・season/citizen が違う・PDA が違う・取り消し済み |
| 9006 | MandateExpired | 委任の期限切れ |
| 9007 | MandateExhausted | 委任の回数を使い切った |
| 9008 | CargoOverCap | 積荷が委任の上限を超える |
| 9009 | NotWallet | 委任の登録・取消の署名者が Citizen の wallet でない |
| 9010 | Accounts | 口座の不足・過剰 |

**互換の規則（案）。** (1) 既存の op とデータは変えない。変える時は op か `iface_version` を上げる。(2) Frontier の `program_version` か ruleset が変わったら、courier は再ビルドするまで拒否する（静かに動き続けない）。(3) Frontier が SendCaravan の口座表を変える場合（MC の `changed_in_v2` と同じ扱い）は、コア側で `program_version` を上げることを前提にする。

## 4. 委任の差し替え点（②の Grant は未受領：仮アダプター）

courier の op 1–3 は**仮アダプター**で、②の Grant ではない。仕組みは、コアに既にある session 鍵だけを使う:

1. 所有者が courier の `RegisterMandate`（op 1、wallet 署名）で上限を登録する: 期限、回数、資源ごとの積荷上限。口座 `["mandate", season, citizen]`（152 B、rent 1,422,400 lamports、取消で全額戻る。ローカル）。
2. 所有者が自分で `SetSession(session = PDA["session", season, citizen], expiry)` を送る（トップレベル、wallet 署名）。
3. 所有者が purse `["purse", season, citizen]`（System 所有、データなし）に SOL を入れる。隊商の rent と fee はここから出て、rent は受取時に purse に戻る。
4. 以後、誰でも（cranker）op 2 を送れる。courier は上限を確認し、session PDA と purse PDA で `invoke_signed` する。

②の Grant に置き換える時の境界（案）:

```text
trait GrantAdapter {
  // courier が CPI の前に呼ぶ。Allow なら courier が signer の seeds を使う。
  fn authorize(grant: &Account, citizen: Pubkey, action: &SendCaravan, now: i64)
      -> Result<Allow { session_seeds, payer_seeds }, Deny { code, name }>;
  // CPI 成功後に呼ぶ（回数などの消費）。
  fn consume(grant: &mut Account, action: &SendCaravan);
}
```

今の `mandate` 口座と op 1–3 がこの trait の仮実装にあたる。Grant を受領したら op 1・3 を削除し、op 2 の上限確認を Grant の判定に置き換える。

**仮アダプターの限界（実行とコードで確認した事実）:**

- **限定はコアの保証ではない。** コアから見ると courier の PDA は session 鍵で、session が行使できる命令すべて（[02](02-instruction-matrix.ja.md)「session 可」）を行使できる立場にある。今の courier のコードが SendCaravan しか呼ばないだけで、courier がアップグレード可能なら、その権限者が後から別の命令を足せる。
- **意図を縛らない。** cranker は上限内で出発元・宛先・経路・積荷を選べる。宛先はコアが所有者自身の場所に限る（`WalletRequired`、`t13`）ので他人へは流れないが、どの自分の場所へ動かすかは所有者が決めていない。
- **他人宛の隊商は委任できない。** session には他人宛の送付が許されない（`WalletRequired`）。他人への受け渡しを委任するには、コアの規則を変えるか、②の Grant がコアに入る必要がある。
- **session の枠は Citizen に1つ。** courier に向けると、relay のエージェント財布（同じ session 枠を使う）は止まる。逆も同じ。
- **取消はコアの SetSession が本体。** courier の `RevokeMandate` は courier 側の上限を消すだけで、session を戻すのは所有者の SetSession（`t13`：戻した後は `Auth`）。

## 5. 他の機能への広げ方（未実装、方針だけ）

同じ型で他の player 命令（BuildVault、RaidCaravan など）を包むことはできるが、どれも [02](02-instruction-matrix.ja.md) の C1–C8 を命令ごとに確かめるまでは「呼べる」と書かない。特に CloseVault・CloseStructure は session 不可、Reveal などは CPI 不可。
