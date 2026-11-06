# 共有 ABI の番号の割当（④、2026-11-06、**仮**、改訂 3：全担当との照合）

## 2026-11-09 integration supplement: closed legacy expedition

Integration provisionally reserves **DA FF 01 06** (class P,
`ExpeditionDepart`) and **DC FF 01 0A** (class D,
`ExpeditionSettleOrigin`) and PS2 kind **146** for the original-issued-troop
boundary experiment. These are unfinalized experimental reservations, not
production allocation changes. The current `wide_ix` opcode constants and
dispatch tables, legacy/v2/resident event schemas, this allocation inventory
and repository proposal/patch text were scanned. DA currently uses operations
1–5; DC uses 1–6, 8 and 9. No existing kind146 definition was found.
Reservations120–145 are preserved, including the separate conquest-only145.

Departure is the four-byte envelope followed by the existing Depart field
encoding (host56, slot1, arrival4, tip8, commit32, seal264):369 bytes.
Origin settlement is the four-byte envelope plus slot1:5 bytes. Neither
reinterprets an existing opcode. Ordered accounts are respectively:
actor, payer, Season, Citizen, original Holding, legacy origin Province,
System, legacy issuer Province, external BridgeTransit; and payer, Season,
legacy origin Province, original Holding, legacy issuer Province, external
BridgeTransit. No account kinds, seeds or financial authority are added here.

Kind146 has PS2 header6, expedition version/action/slot/reserved4, full issued
host56, Citizen32 (zero for settlement), original Holding32, origin key50,
original Province32, external address32 and operation receipt100:344 pre-tail
bytes. Exactly ordered PS2 tails are Citizen4/Holding5/Province6 for departure
(468 total) and Holding5/Province6 for settlement (427 total). Every tail uses
the original `log::advance` algorithm and prior original sequence/head. The
external account is unchained. The344-byte body is an explicit experimental
exception to the128-byte advisory policy; both forms fit the800-byte program
buffer. Existing strict PS2/v2/fclient readers reject146; do not widen their
accepted set without explicit bounded dispatch, same-chain history coverage,
exact buffer tests and replay/provenance validation. PSW1 parsing is not valid.

Versioned expedition-only hash domains commit ordered full pre/post manifests,
role indices, public addresses, owners, presence, observed signer/writable
flags, lamports, whole account bytes, exact command, clock/bell, whole Season,
operation evidence and fixed-width outcomes. Output normalization removes only
original touched chain headers, including any alias of the same account;
external bridge and all other bytes remain intact. Escrow/rent, departure mass
and stamina, origin survivors/stamina/readiness/destruction and lazy finality
are explicit outcomes. Commitments do not prove authentication, original
issuance, conservation, transaction completeness or replay by themselves.
All public lifecycle, depart-debit, mixed, SBF and autosend gates remain closed.

## 2026-11-09 integration supplement: experimental legacy source receipt

Integration provisionally reserves PS2 record kind **145** for the closed
legacy-to-wide conquest source receipt (`world_index::legacy_source_event`).
This is **experimental and unfinalized**, not a deployed allocation or a
compatibility promise. The actual integration-tree kind enums, allocation
tables and proposal text were checked for conflicts; reservations 120–144
remain unchanged. No instruction tag, account layout or chain entity is added.

The body retains PS2 version 1 and adds bridge version 1, Debit/Credit and two
zero reserved bytes, the full legacy-disk source host reference, the canonical
original Holding address and the existing 100-byte conquest operation receipt.
Exactly one ordinary PS2 entity-5 tail continues the original source chain.
The 198-byte pre-tail body is a provisional soft-size exception; the complete
record is exactly 240 bytes. Debit pairs with DECLARE; Credit pairs only with
LAPSE or CAPTURE. FAILED/TABLE_CLOSE/ESCROW_CLOSE never imply source credit.

This reservation enables no emission. The existing program buffer is 800 bytes,
but its v2 width table stops at 134; old ABI/fclient readers reject kind 145.
Before runtime integration, explicitly wire a bounded bridge emitter, same-chain
header updates, reader dispatch, transaction pairing and complete mixed-history
verification, and verify their buffers. Never use PSW1 hashes for legacy headers.
All public/runtime gates remain closed. No production ABI registry is widened.


統合の担当（④）が、命令 tag・記録の kind・Citizen の予約領域を、担当どうしで重ならないように割り当てる。**仮の割当**で、統合候補に入るときに確定し、`contracts/registry.txt`（`e2e-native/tests/registry.rs` が生成）とエラー番号の照合（`error_codes.rs`）で検査する。番号を使うコードは、確定まで各担当の feature（例：⑳の `nft-experimental`）の内側に置く。

基準：統合候補 `ef63544c727490fc6801d30affd11c5b7106c480`。

## 0. 照合の方法（2026-11-06 改訂 3）

`tools/abi_inventory.py`（鍵を使わない。git の参照を読むだけで、checkout も build もしない）で、統合候補と各担当の最新の branch の **コード・未適用の patch・文書の表** から、命令 tag・記録の kind・entity kind・口座の種別（AccountKind／seed tag／magic）・エラー番号（ゲーム program、prize program）・版を抜き出し、重なりを機械的に数えた。結果は `contracts/abi-inventory-20261106.txt`（一覧）と `abi-inventory-20261106.json`（全件）。

| 担当 | 照合した参照（完全 SHA は inventory の json） | 備考 |
|---|---|---|
| 基準 | `integration/ws09-13-v16-d0949fd4` `ef63544c` | ⑧の ContinuousWorld（エラー 94）と prize の ContinuousSeason（0x112）を含む |
| ② | `preserve/ws02-rights-dc3bd3d` | **`2c58034a` は GitHub に無く未確認**。dc3bd3d のコード（`v2/rights.rs`）と `06-EVENTS.ja.md` §3 の割当案で照合 |
| ⑧ | `preserve/ws08-cont-verify-b519cd18`、`…continuous-e3d773df`、`…persistence-ca67d40e` | |
| ⑨ | `claude/elegant-bohr-co2uhr` `cca8481d` | 命令は文書の表（仮タグは取り下げ済み）。記録・プログラムのエラーの件数は**未確認** |
| ⑩ | `claude/great-babbage-3ogkqu` `79fbce83` | patch `0002-ABI-v2-custody-…` の追加行 |
| ⑪ | `claude/kind-fermat-earbxe` `c8d694bd` | 命令は文書の表。記録・エラー・口座の種別の件数は**未確認** |
| ⑱ | `preserve/ws18-4fbe0c77`、`fix/ws18-clippy-hostile-20261103` | 共有の番号の追加なし |
| ⑳ | `claude/funny-wozniak-cy4n64` `512ad6e7` | `frontier-abi/src/resident_wire.rs`。エラーの要否は**未確認** |
| ①③⑤⑥⑦⑫⑬⑭⑮⑰⑲ | 各 preserve／作業 branch | 共有の番号の追加なし（③の文書の表は既存の tag の写し） |
| S2 stage 2e | `ccr-184d6862-fqutoz`（2026-10-24、未統合） | 古い提案。tag 0xC0–0xCC、kind 103–115、エラー 94–101、AccountKind 23–25 を使い、基準の FastForward（0xC0）・REST（103）・ContinuousWorld（94）と衝突。**割り当てない**（使うなら改めて割り当てる） |

## 1. 見つかった重なり（照合の結果、2026-11-06）

| 空間 | 番号 | 主張している担当 |
|---|---|---|
| 命令 tag | 0xC1 | ⑧ ExtendFrontier（コード）、⑩ OpenLot（patch）、⑨ OpenCapacityPool（文書、取り下げ済み） |
| 命令 tag | 0xC2–0xCB | ⑩（patch）と⑨（文書）が同じ範囲 |
| 命令 tag | 0xD0–0xD5 | ② Grant の6命令（コード）と⑪ Ext の6命令（文書）。**④の前回の仮割当で⑨に渡した帯とも重なっていた** |
| 記録 kind | 104 | ⑧ FRONTIER_EXTENDED（コード）と⑩ LOT_OPENED（patch） |
| 記録 kind | 105–109 | ④の前回の仮割当は⑩に5枠。⑩の patch は **9枠（104–112）** を要する |
| ゲームのエラー | 94 | 基準の ContinuousWorld（⑧）と⑩ CustodyCapacity（patch、94–98） |
| AccountKind | 23 | ⑩ Lot（patch）と②の割当案 Grant |

## 2. 衝突のない割当（**仮**。統合で確定するまで正式決定ではない）

既に担当のコードにある番号はできるだけ動かさず、文書や patch だけの番号を動かす。

### 2.1 命令 tag（u8）

| tag | 担当 | 件数 | 担当が変える所 |
|---|---|---|---|
| 0xC1 | ⑧ ExtendFrontier | 1 | なし |
| 0xC2–0xCC | ⑩ OpenLot … WithdrawLot | 11 | patch 0002 の `tags.rs`・`tags.json`・vectors、`02-contract.ja.md`：0xC1–0xCB を **+1** |
| 0xCD–0xCF | 空き | — | — |
| 0xD0–0xD5 | ② IssueGrant、ReserveSwap、ExecuteSwap、ReleaseSwap、RevokeGrant、CloseGrant | 6 | なし（`2c58034a` で同じかは未確認） |
| 0xD6–0xDF | 空き | — | — |
| 0xE0–0xE2（0xE3–0xE7 予備） | ⑳ CreateResidentPolicy、JoinResident、ResidentAct | 3 | なし |
| 0xE8–0xED | ⑪ ExtWriteManifest … ExtWithdraw | 6 | `patches/0002-core-extension-instructions.md` の表：0xD0–0xD5 → **0xE8–0xED** |
| 0xEE–0xEF | 空き | — | — |
| 0xF0–0xFD | ⑨ OpenCapacityPool … RetirePool | 14 | `patches/0002-core-instructions.ja.md` の表：0xC1–0xCE → **0xF0–0xFD** |
| 0xFE | 割り当てない（検証器の「知らない tag」の試験用。⑪の試験は 0xD4 → **0xFE**） | — | ⑪ `patches/0001`／`0004` の試験 |
| 0xFF | 試験だけ | — | — |
| 0x53、0x80–0x91、0xA4、0xA8–0xAF、0xBF | 予約のまま（`tags::is_reserved` と `v2::tags::is_reserved`） | — | — |

### 2.2 記録の kind（u8。v1 と v2 の表は一つの空間。基準は 103 まで、`MAX_KIND_V2 = 103`）

| kind | 担当 | 件数 | 担当が変える所 |
|---|---|---|---|
| 104 | ⑧ FRONTIER_EXTENDED | 1 | なし |
| 105–113 | ⑩ LOT_OPENED … LOT_LOSS | 9 | patch 0002 の `v2/log.rs`・`logs.json`：104–112 を **+1**、`MAX_KIND_V2` を 113 |
| 114–119 | ② GRANT_ISSUED … GRANT_CLOSED | 6 | `06-EVENTS.ja.md` §3：200–205 → **114–119** |
| 120–129 | ⑨（予約。件数**未確認**） | ≤10 | 件数を④へ |
| 130–134 | ⑳ RESIDENT_JOINED（130）と予備 | 1＋4 | なし（前回の訂正どおり） |
| 135–144 | ⑪（予約。件数**未確認**） | ≤10 | 件数を④へ |

`MAX_KIND_V2` と `WIDTHS_V2` は、新しい kind を出す変更で、その番号まで広げる。

### 2.3 entity kind（記録の chain。基準は 1–12）

| 番号 | 担当 | 備考 |
|---|---|---|
| 13 | ⑩ Lot | patch のまま |
| — | ② | Grant は chain にしない（②の案） |
| 14– | ⑨・⑪・⑳ | 要否**未確認** |

### 2.4 口座の種別

| AccountKind | seed tag | magic | 担当 | 担当が変える所 |
|---|---|---|---|---|
| 23 Lot | `cl` | `PSF1CLOT` | ⑩ | なし |
| 24 Grant | `gr` | `PSF2GRNT` | ② | `06-EVENTS.ja.md` §3：AccountKind 23 → **24** |
| 25 CapacityPool、26 CapacityJob | `cp`、`cj` | 未定 | ⑨ | 要否・magic **未確認** |
| 27 ExtRegistration、28 ExtGrant、29 ExtInstance、30 ExtBuffer | `xr`、`xg`、`xi`、`xb` | 未定 | ⑪ | 要否・magic **未確認** |
| 31 resident policy、32 resident link（予約） | — | `PSFNP002`（policy）、`PSFNR001`（link） | ⑳ | 予約だけ。32 の link は、NFT の **Season ごと**の link にする（`["nft-citizen-link", season, asset]`。layout、magic、大きさは変えない。⑳ `dc55f15966d3256b118d645c36ba4591a41e6b3f`、U45、2026-11-06。④が試験を再実行して確認）。`deebd3b5`（すべての世界で共通の link）は置き換えられた。今は独自の 8 B magic で v2 の header を使わないので、読み手の `kind_by_magic` は飛ばす。header に移すのは layout の変更で、別に決める |

seed tag と magic は、基準・各担当の間で重なりなし。

§2 の割当は、基準の使用中の番号とも、担当どうしでも重ならないことを機械的に確かめた（tag 46・kind 41・エラー 89・AccountKind 10・entity 1 の番号）。

### 2.5 エラー番号

ゲームの program（`FrontierError`＋`CqError`、一つの空間。基準は 1–94 と 99。95–98 は空き）：

| 番号 | 担当 | 件数 | 担当が変える所 |
|---|---|---|---|
| 95–98 | 空けておく | — | — |
| 100–104 | ⑩ CustodyCapacity … LotNotEmpty | 5 | patch 0002 の `v2/error.rs`・`errors.json`・生成した JS：94–98 を **+6** |
| 110–149 | ⑨（予約。カーネルの 1–30 を program の番号に写す。件数**未確認**） | ≤40 | 件数を④へ |
| 150–169 | ⑪（予約、**未確認**） | ≤20 | — |
| 170–175（176–179 予備） | ⑳ NotSigned、Asset、Resident、Unguarded、StaleGeneration、NotCurrentAuthority（`resident_auth::Refusal` の6つ。今はすべて InvalidAccountData に潰れている） | 6 | ⑳が配線する（2026-11-06 の申し出、仮） |
| 200–213 | ② | 14 | なし（②の案のまま） |

prize の program（`PrizeError`、0x100 から）：基準は 0x100–0x110 と 0x112。⑧の CeilingPastTally＝0x111 は空きに入っていて重ならない。次は 0x113。

### 2.6 版

| 版 | 基準 | 各担当 | 扱い |
|---|---|---|---|
| `PROGRAM_VERSION_V2` / `_S1` | 3 / 4 | ⑩ `PROGRAM_VERSION_CUSTODY = 5`（patch）、⑳ 試験 build `0x8000 \| S1`、S2（未統合）`PROGRAM_VERSION_S2 = 5` | 統合した program の版は統合で一つに決める。⑩が別の program なら独自の版で、S1 の線の値と比べない。⑳の試験 build は本番の値と重ならない |
| `RULES_VERSION` | S1 は FRONTIER_V3 | ⑩ `RULES_VERSION_FRONTIER_V4 = 13`（patch） | 規則（kernel）を変える担当だけが上げる。ruleset hash もそれで変わる |
| 記録の `VERSION` | 1 | 変更なし | kind を足すだけでは上げない |
| `LAYOUT_VERSION`（v2） | 2 | ⑳は変えない（予約領域の中）。⑩ の S1 layout の変更が版を要するかは**未確認** | — |
| `MAX_KIND_V2` | 103 | ⑧ 104、⑩ 112（patch） | §2.2 のとおり、出す番号まで |

## 3. 各担当に返すこと

- **②**：変更は記録の kind（200–205 → 114–119）と AccountKind（23 → 24）だけ。`2c58034a` を GitHub に置いてほしい（今は照合できない）。
- **⑧**：変更なし。
- **⑨**：命令は 0xF0–0xFD。記録の kind、program のエラー（カーネルの 1–30 の写し）、AccountKind の要る件数を④へ。
- **⑩**：命令 +1（0xC2–0xCC）、記録の kind +1（105–113）、エラー +6（100–104）。AccountKind 23・entity 13・seed `cl`・magic はそのまま。
- **⑪**：命令 0xE8–0xED、試験の「知らない tag」を 0xFE。記録・エラー・口座の件数を④へ。
- **⑳**：変更なし（0xE0–0xE2、kind 130、予約領域）。エラーや AccountKind が要るなら件数を④へ。
- **⑱・その他**：共有の番号の追加なし。

## 5. ⑳の案への④の意見（番号以外）

- **WALLET＝全 0 のとき、財布から作る住所と記録の key を使わない。** `sha256("PSF-CIT" ‖ wallet)` は全 0 の財布で全員同じになり、NFT Citizen どうしの口座と記録の key が衝突する。NFT Citizen の口座の住所と、その Citizen の記録（VIGIL・TICKET・OUTPOST など）の key は、住民 ID（`PSF-RES`）から作る。前置きが違うので、財布から作る key とは重ならない。
- 財布・session の判定が全 0 の WALLET で拒否側に倒れるのは安全側でよい。ただし、拒否に頼る箇所と、住民 ID に置き換える箇所を、⑳の洗い出しの一覧で分けて示してほしい（④の executor・acts の `agentId` も影響を受ける）。

## rev 4（2026-11-06 夕方、統合候補 `ws04/int-20261106` の上で照合）

`tools/abi_inventory.py` を、統合候補（④＋⑳ dc55f159・41552f0d、⑤ e9d1551a、⑬ 745e7ec6、⑫ c6877a1a、⑨ 8fe85cc9、⑩ 563407d9、⑪ c8d694bd、⑪ の 0004・0005）と、⑨・⑩・⑪・⑳・②・⑧ の最新に対して走らせた（結果は `abi-1106b.txt`）。

- **統合候補のコードの中には、番号の衝突がない。**
- 残る衝突 20 件は、すべて各担当の**提案**（patch か文書）が rev 3 の割当にまだ移っていないものである。担当が rev 3 の番号で作り直せば消える。
  - ⑩ の tag 0xC1–0xCB → 0xC2–0xCC、記録 104–112 → 105–113、エラー 94–98 → 100–104。
  - ⑨ の文書の 0xC1–0xCB → 0xF0–0xFD。
  - ⑪ の文書の 0xD0–0xD5 → 0xE8–0xED。

⑩ の依頼（`workstreams/10-custody/11-abi-request-04.ja.md`）への答え：

| 項目 | 割当（仮、統合で確定） |
|---|---|
| ⑩ のエラー 5 つ | **100–104**（案 a。100 以上を開ける）。`frontier-abi` の `codes_are_the_contract_table` は、⑩ を入れる変更で、未割当の範囲を `100..=169` から `105..=169` に直す |
| ⑩ の命令 tag 11 個 | 0xC2–0xCC（⑧ の 0xC1 の後ろ） |
| ⑩ の記録 9 個 | 105–113（⑧ の 104 の後ろ）。`MAX_KIND_V2` は ⑳ の 130–134 があるので 134 のまま |
| AccountKind・EntityKind・seed | 23 Lot、13 Lot、`cl`（rev 3 のまま。②は AccountKind 24） |
| 利用注文の用途 `0x0901`（工房の兵器） | ⑨・⑩ の共有値として仮に確定 |
| プログラムの版 | `custody-preview` の build は版 5（`RULESET_HASH_V4`）のまま。未統合の S2 stage 2e も 5 を名乗るが、S2 は割り当てていないので、統合するときに S2 側を動かす |
| 検証器の検査番号 | **V26 は ⑩（custody-history）**。V0E は ⑪（0004・0005 で統合候補に入った）。V18・V21 は空き。今の統合候補で使用中の番号は V0–V17、V19、V20、V22–V25、V0E |

## rev 6（2026-11-07、NFT パスの賞金。**仮**、④の確定待ち）

賞金 program（`permutation-prize`、feature `nft-experimental` の内側。無しでは `BadData`）。`permutation-prize/NFT-PRIZE.md`。

| 空間 | 番号 | 内容 |
|---|---|---|
| 賞金の命令 tag | 8 PayResident、9 ClaimResident、10 RecordResidentNation | パスの今の持ち主が払う・受け取る。国の記録は誰でも |
| 賞金のエラー | 0x113–0x118（`resident_auth` の 6 つの拒否を賞金の番号で）、0x119 ResidentPolicy、0x11A ResidentRefundUndecided、0x11B ResidentDepositsDisabled（tag 8 は dispatch で必ずこれを返す。返金先が決まるまで NFT の入金は受けない） | 0x111 は⑧の CeilingPastTally のために空けたまま |
| 賞金の口座 | NFT Entry：PDA `["entry-nft", pool, asset]`、192 B、magic `WYPRNFTE` | 財布の Entry（128 B、`WYPRENTR`）とは大きさも magic も違う。欄は registry.txt `[prize_entry_resident_fields]` |
| shares の leaf | `sha256(0x02 ‖ pool ‖ asset ‖ nation ‖ points)` | 財布の leaf は 0x00、node は 0x01。同じ root に両方を入れる |

読む側の口座（ゲーム program のもの。番号の追加なし）：policy PDA `["nft-resident-policy"]`（`PSFNP002`）、link `["nft-citizen-link", season, asset]`（`PSFNR001`）、NFT Citizen（`RESIDENT_ASSET` @348、`RESIDENT_FLAGS` @380）、Core の asset、住民 program の `["resident", asset]`。決めていないこと：refund の行き先（払った人か今の持ち主か。NFT の Entry の refund は拒否）、旧い財布の Entry から NFT への移行、世界間の引き継ぎ（U11）。

## rev 5（2026-11-06 夜）

| 項目 | 割当（仮、統合で確定） |
|---|---|
| nft-experimental の S1 build のプログラムの版 | `0x8000 \| PROGRAM_VERSION_S1`（= 0x8004、⑳ の `permutation-frontier` の値のまま）。検証器は、この版を「S1 の規則＋住民の命令 0xE0–0xE2」として扱う（`verify::checks::v0_coverage::PROGRAM_VERSION_RESIDENT_S1`） |
| 住民の命令 0xE0–0xE2 | rev 3 のまま（0xE3–0xE7 は予備）。この版の Season の外で成功すれば、検証器は FAIL |
| 記録 kind 130 | ⑪ の 0008 で CONDITIONAL（同じ取引の JoinResident と一致するときだけ判定）。⑳ の 45d95e31 と ④ の V9 で、偽造・欠落・不一致・重複を拒否 |

## rev 6（2026-11-06 夜、⑳ b2f7becc と ⑪ 0010 を統合した後）

| 項目 | 割当（仮、統合で確定） |
|---|---|
| 検証器の V28 | ⑳ の ResidentAct の判定（`checks/v28_resident_acts.rs`）。V27 の後、s1 の区画で動く。番号の重なりはない（使用中は V0–V17、V19、V20、V22–V25、V27。V26 は ⑩ に割り当て済み） |
| 判定の code | `ResidentActMismatch`、`ResidentOldAuthority`、`ResidentActUnproven`、`ResidentInnerUnmodelled`（⑳ が codes.rs に追加） |
| 住民の所有者の定義 | `frontier_abi::resident_auth::holder` と `Holder::authority` の一つだけ（⑳）。④ の通しの場面（chain_nft）も、これで読む |
| `ResidentFeed` の Input の欄（U47 の残り） | **未決**。resident program の取引を同じ feed seq で並べる feed、または archiver が要る。決まるまで、所有者の判定は UNVERIFIABLE |
