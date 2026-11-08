# patches: 共有コアへの変更案

> **r17（2026-11-08）。** [0017](0017-verify-v27-join-bell-unverifiable-without-season-created-on-16576826.patch) は、SEASON_CREATED が archive に無いとき、V27 の join の bell の照合を UNVERIFIABLE にする（元は正しい join を FAIL にしていた）。当て先は `16576826`。SHA-256 は `babba7ffbd7f1e4e171d5724601ab60bc56461bb8806a097ac438cebdd1c8849`、tree は `f7af5bd501f84b3119dba7ee2a77b1eb5f484f68`。

> **r16（2026-11-08）。** [0016](0016-verify-v0-wide-tags-left-to-vw-on-ws04-4ecef1d9.patch) は、wide の build の Season で wide のタグを VW に任せる（UNVERIFIABLE `WideUnmodelled`）もの。当て先は `4ecef1d9`。SHA-256 は `7aaf442c911e41f5e570e09a90bfb20cf836531e6ec384c977c5b131b88a85ad`、tree は `689c264ef67f72caad0a8b8cb736561a02296e13`。0015 も重ねて当たる。

> **r15（2026-11-08、②が見つけた穴）。** [0015](0015-verify-v0e-every-abi-v2-account-kind-on-cf517b55.patch) は、V0E が S1 の口座（MarchState、Vault、Caravan、Structure、Nation、Lot）の事後状態の欠落も UNVERIFIABLE にするもの。当て先は `cf517b55` で、0013 と 0014 とは別のファイルなので、順は問わない。SHA-256 は `68b6a039a048f7029f0ec599220d1cd710ac174f9562ec6baf4dc9da9e3dac1d`。`b2bd9711`＋0013＋0014＋0015 の tree は `60bd0044052fa192c86956027402b669cc6afdda`。

> **r14（2026-11-08）。** 当てる順は 0013 → ⑳の `b2bd9711`（入れ替えてもよい）→ [0014](0014-verify-v0-resident-act-left-to-v28-after-ws20-b2bd9711.patch)。0014 の SHA-256 は `f8763979f44bcb20814f185dcaac7f2db092c22254db639f9a7a908ad123b10d`、当てた後の tree は `38e164a8a82b212f69e02f3ac341f1c35541933c`。中身: ResidentAct を V28 と内側の命令の検査に渡す。条件は、V28 が動き（s1）、act がその内側の命令を実行すること。詳細は [17](../17-verifier-r13.ja.md) §7。

> **r13（2026-11-08）。** ④の公開統合候補 `cf517b55` へは [0013](0013-verify-v0-forgery-only-under-a-known-program-and-keyfree-coverage-on-cf517b55.patch) を当てる。SHA-256 は `84fdbe7b2b588f2516fa3eeb376af466fef72b5ab5f68a601c5aee18582eae35`、当てた後の tree は `9ab02b5a78f23f849c13847e0f44f1f86b5fff4b`。中身は 2 つ。V0 が偽造（FAIL）とするのは知っている版のプログラムのときだけにした。ABI の coverage の契約を、鍵なしで確かめる試験を足した。詳細は [17](../17-verifier-r13.ja.md)。

> **r11（2026-11-06）。** 当てる順は 0010（`6984acfa` へ）→ ⑳の `4b233e4a`・`b2f7becc` → [0011](0011-verify-v27-resident-proof-accounts-canonical-after-ws20-b2f7becc.patch)（SHA-256 `f59e1ab5c870d8adb9147611481f19152d1e843d2df464767dd37425073f253c`）。0011 は V27 で JoinResident の policy、link、resident の正規アドレス（PDA）を照合する。tree は `9a9e49e0b1e38b516d29b9a6cff6afa386b7538a`。詳細は [16](../16-verifier-r11.ja.md)。

> **r9（2026-11-06）。** ④の候補 `d0e96d53` へは、⑳の `45d95e31` を当ててから [0009](0009-verify-v27-join-resident-on-ws04-d0e96d53-after-ws20-45d95e31.patch) を当てる。0009 の SHA-256 は `39da19690fa070c019630e100c9535a2fe21f2d95bd5a3dc9bb3a7a2c4f2a823`、当てた後の tree は `1bec57a040640820c0032549470aab9c9300906c`。正しい JoinResident を検証する（V0 が NFT 版を知り、V27 で命令・記録・Citizen・link・時刻を照合する）。②の正当な命令（知らない版）と偽の命令は V0 で区別する。詳細は [15](../15-verifier-r9.ja.md)。

> **r8（2026-11-06）。** ④の候補 `4c65aaa2`（0004→0005→0007 を適用済み、⑳の RESIDENT_JOINED 入り）へは [0008](0008-verify-v0e-resident-joined-beside-its-join-on-ws04-4c65aaa2.patch) を当てる。SHA-256 は `e71b7892329ccbf44dda028026ce2de4cffd3d7c42b5514782ae08698e5cf98f`。kind 130 は、一致する JoinResident の横にあるときだけ判定される側に数え、それ以外は UNVERIFIABLE とする。詳細は [14](../14-verifier-r7.ja.md) §6。

> **r7（2026-11-06）。** ④の現在版 `claude/gallant-ride-cunptv` @ `8e96f24d` へは **0006 だけ**を当てる（0004＋0005＋r7 の判定を 1 つにしたもの。`ef63544c` にも当たる）。0004・0005 を当て済みなら 0007 を足す。どちらの順でも tree は `d72a025c16a62650920a495f9f1a1a9e756e42a2`。詳細は [14](../14-verifier-r7.ja.md)。
>
> | パッチ | 当て先 | 状態 | SHA-256 |
> |---|---|---|---|
> | [0006-verify-v0e-evidence-and-records-on-ws04-8e96f24d.patch](0006-verify-v0e-evidence-and-records-on-ws04-8e96f24d.patch) | `8e96f24d` | 未適用。許された試験 50 件通過。新しい帯の命令・記録と記録の書き足しで PASS 0 | `81841f83b984ee8f340609db64bf055fe7323471fac7563af32a430e78d3f391` |
> | [0007-verify-v0e-unverified-record-after-0005.patch](0007-verify-v0e-unverified-record-after-0005.patch) | 0004 → 0005 の後 | 未適用 | `0ee4510c4e8982d4f1364d173a5d789523c523e49d6ad335cd8048a793dd1aa5` |

> **r6（2026-11-06）。** 統合候補の先端は `ef63544c`。④へは **0004 → 0005** の順（どちらも未適用）。0005 は 0004 が残した 2 つの PASS の経路（ログの無い CPI だけの取引、印なしに失われたログの末尾）を塞ぐ。⑯の P1 は統合候補に当たらず、その内容は⑱の V0＋0004＋0005 が覆う。詳細は [13](../13-verifier-r6.ja.md)。
>
> | パッチ | 当て先 | 状態 | SHA-256 |
> |---|---|---|---|
> | [0005-verify-v0e-cpi-only-and-lost-tail.patch](0005-verify-v0e-cpi-only-and-lost-tail.patch) | 0004 を当てた `ef63544c` | 未適用。当てた後、許された試験 45 件通過、証拠の欠けた 1,380 件で PASS 0（0004 までは 141 件が PASS） | `09beb7bce149c3628f516f1b6285c090e9f159ea1b7fb916fcd0e304f4067639` |

> **r5（2026-11-05）の状態。** 統合の先端 `integration/ws09-13-v16-d0949fd4` では **0003 が適用済み**。**0001 は再適用しない**（知らないタグは⑱の V0 が FAIL とし、0001 の UNVERIFIABLE と食い違う。⑱を正とする。0001 の CPI の部分は 0004 が置き換える）。**0004 は新規・未適用**で、統合の先端に当たる。詳細は [12](../12-verifier-r5.ja.md)。
>
> | パッチ | 当て先 | 状態 | SHA-256 |
> |---|---|---|---|
> | [0004-verify-v0e-evidence-is-unverifiable.patch](0004-verify-v0e-evidence-is-unverifiable.patch) | 統合の先端 `d0949fd4`（V0 の後に V0E を足す。⑱の V0 は変えない） | 未適用。当てた後、検証器の試験 106 件通過、CPI・切れたログ・ログ無し・Holding 以外の post-state の欠落 902 件で PASS 0（前は 452 件 PASS） | `258ad75901a637c97f4df06655b2d01b4f744a255eff8bbeacfb6ff22dd21660` |
> | 0001 | — | 取り下げ（再適用しない） | — |
> | 0003 | — | 統合の先端に適用済み | — |
>
> 以下は r3 時点の記述（基準 `4cd901de` に対するもの）。


| パッチ | 対象 | 種類 | 確認 |
|---|---|---|---|
| [0001-verify-unknown-instruction-is-unverifiable.patch](0001-verify-unknown-instruction-is-unverifiable.patch) | `frontier-node/crates/verify`（V2 と試験 `unknown_ix.rs`） | コード差分。**r3 で拡張**: 知らないタグの命令に加え、Frontier が CPI で呼ばれた取引（ログの `invoke [n]`、n > 1）も UNVERIFIABLE | 基準 commit に単独で `git apply --check` が通る。当てる前: 知らないタグも CPI も PASS。当てた後: 知らないタグ、CPI の 135 取引すべてが非 PASS。SHA-256 `89047a7f781c3998f2753c68e7ac47d4c3b6ad5c4cc7eaacae1a81ce7ad45c36`（r2 の版は `55324a5d4e98fb1f877a65f8e4d661708a9f08550581f16b00a9c29d624910b1`、r2 のパッケージと commit `93f51b69` に残る） |
| [0003-verify-v7-missing-holding-state-is-unverifiable.patch](0003-verify-v7-missing-holding-state-is-unverifiable.patch) | `frontier-node/crates/verify`（V7 と試験 `missing_state.rs`） | コード差分（r3 新規）: 前の post-state の無い Holding の書込、書込可の既知の Holding に post-state が無い取引、post-state の無い archive を UNVERIFIABLE | 単独でも 0001 と一緒でも当たる。当てる前: Holding の post-state を落とすと PASS。当てた後: 8 個すべて非 PASS。SHA-256 `d18c2f34fc87cc31cdebd5350297fb417fdef64c8b2bc40dcae16db1c0f02a76` |
| [0002-core-extension-instructions.md](0002-core-extension-instructions.md) | `frontier-abi`、`permutation-frontier`、検証器 V7、relay | 設計案（コード差分なし）。案 B は未採用 | 未実行 |

両方を当てた状態で、既存の検証器の試験（lib 12、camp_clear 3、fixtures 9、tamper 58、unit 8）と追加の試験（unknown_ix 3、missing_state 2）の計 95 件が通過（`../results/verify-after-r3.log`）。チェーン上では何も確かめていない。

当て方（採用が決まった場合、integrator の作業）:

```sh
git apply workstreams/11-extensions/patches/0001-verify-unknown-instruction-is-unverifiable.patch
git apply workstreams/11-extensions/patches/0003-verify-v7-missing-holding-state-is-unverifiable.patch
cd frontier-node && cargo test --locked -p verify --test unknown_ix --test missing_state
```

0001 と 0003 は拡張の採否と無関係に、既存の検証器が「知らない操作・欠けた状態を黙って飛ばす」ことを塞ぐ。③の [patches/0002](https://github.com/r0ze998/wylls/blob/2f8ec700/workstreams/03-composability/patches/0002-verify-inner-instructions.md)（CPI の内側の命令を集める）と組み合わせると、内側に現れた知らないタグも同じ扱いになる。
