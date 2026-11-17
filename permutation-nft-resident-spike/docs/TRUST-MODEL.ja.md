# 誰を信頼する設計か：専用売買方式の安全性評価（2026-10-31、v0.4）

「専用経路なので安全」とは結論づけない。専用売買方式（Core ＋ Permanent Freeze ＋ Permanent Transfer Delegate ＋ 住民プログラム）は、**譲渡の経路を 1 本に絞る代わりに、その 1 本を握る者への信頼を増やす**設計である。以下、誰が何をできるか、鍵が侵害されたときに何が起きるか、何で縛るかを分けて書く。

## 1. 権限の所在と、できること

| 権限 | 保持者（想定） | できること | できないこと | 失効・変更 |
|---|---|---|---|---|
| **住民プログラムの upgrade authority** | 運営（単一鍵なら 1 人） | プログラムを差し替える＝prologue・`Buy`・`TransferResident` の規則を**何にでも**変えられる。Permanent Transfer Delegate の authority は プログラム PDA なので、差し替え後のプログラムは**全 asset を任意に移せる**。`HOLDER_GEN` の規則も変えられる | — | `set-upgrade-authority` で多重署名へ、または `None`（凍結）にできる。凍結後は修正不能 |
| **Permanent Transfer Delegate**（authority = プログラム PDA） | プログラム（間接的に upgrade authority） | 任意の asset を任意の宛先へ移す（forceApprove、凍結中も） | authority の変更・削除（永続プラグインは作成時に固定、公式：「Authority is never revoked」） | 不可 |
| **Permanent Freeze Delegate**（authority = プログラム PDA） | 同上 | 凍結・解凍 | 同上 | 不可 |
| **collection の update authority** | 運営の発行鍵 | 新規 asset の mint（collection への追加）、collection の Authority-managed プラグイン（Royalties, Attributes, UpdateDelegate）の更新、collection レベルの凍結（Permanent Freeze が collection に付いていれば） | 既存 asset の永続プラグインの変更、owner の変更 | 鍵の交換（`UpdateCollection`）。供給数の上限は Core 自体には無い（運営の規律か、プログラムで mint 数を数える） |
| **relay の運営鍵**（fee payer プール、collection authority を relay が持つ場合、operator token、状態ファイル） | 運営 | 手数料の肩代わり、relay 側の資格情報の発行・失効、waitlist 表示、出品 desk の記録 | チェーン側の所有権・世代（プログラムが判定） | 鍵ローテーション |
| **保有者のウォレット鍵** | 利用者 | 住民の操作、`SetSession`、出品・贈与・購入 | 他人の住民の操作 | 利用者の責任 |
| **session 鍵／agent 鍵** | 利用者・relay の keyring | 現世代で設定された範囲の操作 | `SetSession`、譲渡、出品（NEVER_DELEGATED 相当） | 譲渡で自動失効、`SetSession` で差し替え |
| **MCP capability** | 利用者が渡した相手 | relay 経由の操作要求 | 署名、所有権 | 世代で失効、rotate |

**要点**：この方式で最も強い権限は **upgrade authority** であり、次に **collection authority**（新規発行＝供給の増加）。Permanent Delegate そのものは「プログラムの延長」で、プログラムが正しければ正しく、差し替えられれば何でもできる。

## 2. 鍵の侵害時に起きること

| 侵害された鍵 | 攻撃者ができること | 検知 | 復旧 |
|---|---|---|---|
| upgrade authority | プログラム差し替え → 全住民 asset の強奪、世代規則の無効化、売買代金の横取り | 公開チェーンの `Upgrade` 取引（誰でも監視できる） | 不可逆の被害。事前の縛り（§3）しかない |
| collection authority | 無制限に住民 asset を発行（供給の毀損、waitlist の水増し）。既存 asset の凍結（collection レベルの Permanent Freeze がある場合） | mint 数の監視 | authority を交換。既発行の偽物は collection に正規に属するので区別不能 → **発行数をプログラムで数え、上限を持つ**ことが必要（U1 と連動） |
| relay の fee payer／operator token | 手数料の浪費、relay 側の表示・資格情報の改竄（waitlist 表示、capability の発行） | relay のログ | ローテーション。チェーン側の所有権・世代には影響しない |
| 保有者ウォレット | その住民の操作、売却（代金は攻撃者へ）、贈与 | — | 利用者の問題。譲渡後は世代更新で旧権限が切れる（買い戻しても復活しない） |
| session／agent 鍵 | 現世代の操作のみ。譲渡・出品・`SetSession` は不可 | relay の記録 | 保有者の `SetSession` |
| プログラム PDA の seed（秘密ではない） | 影響なし（署名は CPI でのみ可能） | — | — |

## 3. 信頼を縛る手段（提案、未実装・未決）

| 対策 | 内容 | 状態 |
|---|---|---|
| upgrade authority の多重署名＋遅延 | Squads 等の多重署名、または時間遅延付きの upgrade。差し替えが単独・即時にはできないようにする | 未決（U21） |
| upgrade authority の凍結 | 監査後に `None`。以後はプログラムを直せない（バグも直せない） | 未決 |
| 運営権限の開示 | 「運営は（upgrade authority を通じて）全 asset を移動できる立場にある」ことを利用規約・README に明記 | 未決（U21） |
| 供給数の上限をプログラムに | mint を住民プログラム経由に限り、カウンタで上限（数値は未決） | 未決（U1） |
| 監視 | upgrade／collection authority の取引を公開で監視し、告知する | 未決 |
| verifier（⑯） | 各命令の actor・世代・保有者を独立に再判定する検査（既存 verifier の拡張） | 統合条件 C8 |

## 4. 一般市場対応方式（Token-2022 ＋ Transfer Hook）との比較（信頼の面）

- フックプログラムの upgrade authority が同じ立場（全転送の可否を握る）。永続 delegate は無いので「運営が asset を直接動かす」能力は無いが、「転送を全て止める」能力はある。
- mint authority は発行後に放棄できる（供給の固定）。Core の collection authority は mint の権利を持ち続ける（放棄は collection の update authority を `None` にすることで可能か、要確認）。
- 市場の契約（escrow 等）への信頼が加わる。

## 5. 結論

専用売買方式の安全性は「**プログラムが正しく、その upgrade authority と collection authority が運営の統制下にあり、運営を信頼できる**」ことに依存する。利用者から見れば、運営（と、運営の鍵を握る者）を信頼する設計である。模擬で確かめたのは「プログラムの規則が意図どおり働けば、保有者以外は何もできない」までで、「運営が規則を変えない」ことは技術では担保していない（§3 の縛りが要る）。
