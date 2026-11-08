# 02 命令と権限の一覧

全 74 命令の機械生成表（口座の完全な並び、データ長、CU 上限、`L(kind)`、コアの試験が検査するエラー）は [generated/instruction-matrix.generated.ja.md](generated/instruction-matrix.generated.ja.md)。`courier-tests/tests/matrix.rs` が `frontier_abi::v2` の表とコアの試験登録簿（`cover::covered_by`）から作るので、コードとずれない。ここでは外部接続に関わる主要命令を、人が読むための列で並べる。

## CPI 可否の判断基準（`top_level_only=false` だけで判断しない）

ある命令が「別のプログラムから呼べる」には、次の**すべて**が要る。courier で SendCaravan について一つずつ実行で確かめた（`courier-tests/tests/courier.rs`、[06](06-results.ja.md)）。

| # | 条件 | 根拠 | SendCaravan |
|---|---|---|---|
| C1 | `top_level_only = false`（`get_stack_height() > 1` で `NotTopLevel` にしない） | `frontier-abi/src/v2/tags.rs`、`permutation-frontier/src/prologue.rs:142` | 満たす |
| C2 | 署名者（actor、payer）が外側の取引の署名か、呼び出し側の PDA の `invoke_signed` で用意できる。CPI は署名を作れない | ランタイム（`t11` の `PrivilegeEscalation`）、`t02` の `Auth` | 所有者の署名（`t01`）か、session 鍵に設定された PDA（`t12`）で満たす |
| C3 | payer が System 所有でデータなしの口座（Frontier は System 経由で rent を移す） | `permutation-frontier/src/init.rs` `init_with_seed` | wallet、または呼び出し側の System 所有 PDA（purse）で満たす |
| C4 | 口座表の書込・読取の区別が、**同じ取引の他の命令と衝突しない**（読取専用位置の program 口座が取引内で書込可だと `BadAccount`） | `frontier-abi/src/prologue.rs` `check_flags` | 単独なら満たす。BuildVault・SettleCaravan との同居は不可（`t08`、`t10`、[03](03-composition.ja.md)） |
| C5 | 命令が instructions sysvar（同じ取引の他の命令）を読まない | `beacon.rs`、`clash.rs`、`reveal.rs` の `evidence::read` | 読まない |
| C6 | 呼び出し側の ProgramData を足しても SIMD-0186 の読込上限に収まる | `drill`（validator 3.1.9） | 収まる（1 Province で 1,809,312 B、relay の `L(kind)` 1,835,008 B） |
| C7 | 呼び出し側の CPI 分の CU を足しても上限に収まる | `t20` | 収まる（+6,214 CU、上限 140,000） |
| C8 | オフチェーンの検証器・索引が CPI の命令を扱える | `frontier-node/crates/verify/src/world.rs:337-350`（トップレベルの命令だけ集める） | **満たさない見込み**（コードを読んだ結果、未実行）。[patches/0002](patches/0002-verify-inner-instructions.md) |

`top_level_only = true` の 13 命令（ConsumeGenesisSeed、PostAnchor、PostAnchorMulti、PostSeed、PostBeacon、ConsumeRingSeed、OpenProvince、Reveal、GatherClash、ResolveFromInputs、ResolveClash、SkipQuiet、FastForward）は CPI で呼べない（`tests/matrix.rs` が一覧を固定）。

## 主要命令の表

凡例: **CPI** 列は「拒否なし（C1 のみ確認）」「**実行確認**（C1–C7 をローカルで確認）」「拒否」。**session** 列は session 鍵で行使できるか。**利用者負担** はトランザクション手数料（署名1つ 5,000 lamports、ローカル）以外に payer から出る lamports（relay の drain guard の許容額 `permutation-gateway/src/frontier/shapes.mjs` `allowanceFor` と同じ考え方）。アドレスはすべて Frontier プログラムの id の下で `create_with_seed(season_pda, "<種別>‖hex(key)")`（Season だけ PDA）。

| 命令 (tag) | 主な入力 | 書込口座 | 署名者 | 作成する口座 | session | CPI | 利用者負担 | 主なエラー（コアの試験が検査） |
|---|---|---|---|---|---|---|---|---|
| Join (0x30) | faction ほか | payer, citizen, joinshard | wallet, payer, (join_gate) | Citizen（`ct‖tag15(wallet)`） | 不可（wallet） | 拒否なし | rent(Citizen) | Capacity, JoinGate, AlreadyDone, Auth |
| SetSession (0x31) | session 鍵, expiry（≤ now+30日） | payer, citizen | actor=wallet, payer | — | **不可**（wallet のみ） | 拒否なし | 0 | BadData, Auth, Bucket |
| PlaceHome (0x38) | site | payer, citizen, province, holding, joinshard | actor, payer | Holding | 可 | 拒否なし | rent(Holding) | ReservedSite, AlreadyDone, TicketState |
| Harvest / Build / Train (0x40–0x42) | 項目・数 | citizen, holding,（Build: province r\|w） | actor, payer | — | 可 | 拒否なし | 0 | Insufficient, QueueFull, CapturePending, NotFinal |
| Depart (0x50) | 封印した行軍, tip | citizen, holding, province | actor, payer | —（holding・province に書く） | 可 | 拒否なし | tip + march_fee + seal_bond | TipTooLow, ArrivalBell, HostBusy, Cooldown |
| Reveal (0x51) | 封印の中身 | 多数 | fee_payer | — | — | **拒否**（top-level only、instructions sysvar を読む） | — | NotTopLevel ほか |
| BuildVault (0xB0) | tile | payer, citizen, holding, vault | actor, payer | Vault（`va‖p,q,tile`） | 可 | 拒否なし | rent(Vault) | VaultSite, VaultLimit, Insufficient |
| **SendCaravan (0xB1)** | seq（= Citizen.CARAVANS）, 宛先 kind/p/q/at/gen, steps, path, cargo[8], fee ≥ 50,000 | payer, citizen, src, caravan, path_province×1–4 | actor, payer | Caravan（`cv‖owner_tag,seq`） | 自分の場所の間のみ（他人宛は `WalletRequired`） | **実行確認** | rent(Caravan) + fee = 2,325,840（ローカル）。rent は settle で payer に戻り、fee は settle した者へ | BadData, Path, Insufficient, WalletRequired, ProvinceBusy, NotOwner |
| SettleCaravan (0xB2) | beneficiary | fee_payer, caravan, dst, beneficiary, rent_to | fee_payer（誰でも） | —（Caravan を閉じる） | — | 拒否なし | 0（fee を受け取る側） | CaravanEarly, RaidState, BadAccount |
| RaidCaravan (0xB3) | p, q, take/burn, 経路 | citizen, caravan, path_province×1–7 | actor, payer（襲撃側） | — | 可 | 拒否なし | 0 | NotOwner, RaidState, RaidWindow |
| DefaultRaid (0xB6) | 経路, beneficiary | fee_payer, caravan, beneficiary, path_province | fee_payer（誰でも） | — | — | 拒否なし | 0 | RaidWindow |
| SeizeVault (0xB4) | 部隊の entry | citizen, vault, owner_citizen | actor, payer | — | 可 | 拒否なし | 0 | NotOnTile, VaultLimit |
| CloseVault (0xB5) | — | citizen, vault, rent_to | actor, payer | — | **不可**（`WalletRequired`） | 拒否なし | 0（rent が戻る） | WalletRequired, NotOwner |
| BuildStructure (0xB7) | kind, tile, notify | holding, province, structure | actor, payer | Structure（`tw‖p,q,tile`） | 可 | 拒否なし | rent(Structure) | StructureSite, StructureLimit |
| CloseStructure (0xB9) | — | structure, province, rent_to | actor, payer | — | **不可**（`WalletRequired`） | 拒否なし | 0 | WalletRequired |
| FortGarrison (0xBA) | troops | holding, province | actor, payer | — | 可 | 拒否なし | 0 | StructureLimit, NotResident |
| Propose / Vote (0xBB, 0xBC) | 種別・対象 / id, yes | citizen, nation | actor, payer | Nation（初回のみ） | 可 | 拒否なし | rent(Nation)（初回の Propose） | NotVoter, ProposalState |
| SettleProposal (0xBD) | slot, id | season, nation, target | fee_payer | — | — | 拒否なし | 0 | ProposalState |
| RaidDomestic (0xBE) | bell, entry | citizen, province | actor, payer | — | 可 | 拒否なし | 0 | RaidState, RaidWindow, NotOnTile |
| DeclareSiege (0xA0) | site, entry | src_holding, province | actor, payer | — | 可 | 拒否なし | holding rent 以内 | SiegeBusy, Shielded, Friendly ほか多数 |

どの player 命令にも前置き（`frontier_abi::prologue::player_prologue`）の `Auth`（actor が wallet でも有効な session でもない、署名がない）、`SessionExpired`、`Bucket`（行動の速度制限）、`WrongStatus`、`RulesetMismatch`、`BadAddress`（Season・Citizen の正準アドレス）、`BadAccount`（所有者・magic・書込区別）、`TooManyAccounts` が加わる。

## session 鍵の範囲（委任を考える前提）

**事実（コード）:** session 鍵は Citizen ごとに1つ（`citizen.SESSION`, `SESSION_EXPIRY`）。wallet だけが `SetSession` で設定・変更でき、期限は最大 30 日。session は、上の表で「可」の命令すべてを行使できる。命令ごと・資源ごと・回数ごとに絞る仕組みは**コアにない**。絞っているのは、relay のエージェント経路（サーバー側の方針）と、courier の仮アダプター（courier プログラム側）だけ。

したがって「限定委任」をコアの保証にするには、②の Grant に相当する仕組みがコアに要る（この担当では作らない。[04](04-interface-contract.ja.md) §4、[patches/0004](patches/0004-core-scoped-delegation.md) は要求の整理だけ）。
