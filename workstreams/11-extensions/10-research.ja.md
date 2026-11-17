# 10 調査: 拡張モデルの先例と Solana の一次資料（2026-10-30）

> コードは固定 SHA の raw ファイルを読んだだけで、実行・clone していない。**未確認** と書いた項目は一次資料で確かめていない。

取得方法: raw.githubusercontent.com を固定 SHA で読み取り（コード実行なし）。行番号は各 SHA 時点。solana.com はレート制限（429）で本文取得不可のため、Agave ソースを優先した。

## 0. Solana 一次資料（Agave v3.1.9 = commit 765ee54a）

| 事実 | 値 / 根拠 |
|---|---|
| CPI 深さ | `MAX_INSTRUCTION_STACK_DEPTH = 5`（トップレベル + CPI 4 段）、SIMD-0268 有効時は `9`（CPI 8 段） https://github.com/anza-xyz/agave/blob/v3.1.9/program-runtime/src/execution_budget.rs#L8-L17 。超過時は `InstructionError::CallDepth` https://github.com/anza-xyz/agave/blob/v3.1.9/transaction-context/src/lib.rs#L160 |
| SIMD-0268 の状態 | v3.1.9 に feature `raise_cpi_nesting_limit_to_8`（6TkHkRm…3mj）としてコードは存在 https://github.com/anza-xyz/agave/blob/v3.1.9/feature-set/src/lib.rs#L1142-L1143 。テストネット・devnet・メインネットとも**未有効**、メインネットは「Agave 4.4 以降、日付未定」、SIMD-0219 の有効化が前提条件 https://solana.com/upgrades/cpi-nesting-depth 。結論: 3.1.x のメインネットでは 5 段（solana-test-validator は既定で全 feature を有効にするため注意。出典は同ページ） |
| 1 tx の命令総数 | `MAX_INSTRUCTION_TRACE_LENGTH = 64`（CPI を含む） https://github.com/anza-xyz/agave/blob/v3.1.9/transaction-context/src/lib.rs#L41 |
| SBF の呼び出し深さ | `MAX_CALL_DEPTH = 64` https://github.com/anza-xyz/agave/blob/v3.1.9/program-runtime/src/execution_budget.rs#L34 |
| 再入禁止 | スタック上にあるプログラムを再度呼ぶと `ReentrancyNotAllowed` になる。ただし直前の呼び出し元自身を呼ぶ場合（直接の自己再帰）は許可（`contains && !is_last`） https://github.com/anza-xyz/agave/blob/v3.1.9/program-runtime/src/invoke_context.rs#L242-L260 |
| realloc 上限 | `MAX_PERMITTED_DATA_INCREASE = 10 KiB`（1 回のプログラム呼び出しごと） https://github.com/anza-xyz/solana-sdk/blob/f5fd9ece3920419edb69eaf78fb896844b3cd971/account-info/src/lib.rs#L23 。CPI 時の検査 https://github.com/anza-xyz/agave/blob/v3.1.9/program-runtime/src/cpi.rs#L1169 |
| アカウント上限 | `MAX_ACCOUNT_DATA_LEN = 10 MiB`、1 tx の増加上限は 20 MiB https://github.com/anza-xyz/agave/blob/v3.1.9/transaction-context/src/lib.rs#L34-L38 |
| CU | 既定値 200,000 / 命令、上限 1,400,000 / tx https://github.com/anza-xyz/agave/blob/v3.1.9/program-runtime/src/execution_budget.rs#L39-L44 。ヒープの既定値は 32 KiB、最大 256 KiB（同ファイル #L48-L49） |
| tx サイズ | `PACKET_DATA_SIZE = 1280-40-8 = 1232` https://github.com/anza-xyz/solana-sdk/blob/f5fd9ece3920419edb69eaf78fb896844b3cd971/packet/src/lib.rs#L37-L42 |
| rent 免除 | `DEFAULT_LAMPORTS_PER_BYTE = 6960`（SIMD-0194 後の表現）、`ACCOUNT_STORAGE_OVERHEAD = 128`。最低残高 = (128 + bytes) × 6960 https://github.com/anza-xyz/solana-sdk/blob/f5fd9ece3920419edb69eaf78fb896844b3cd971/rent/src/lib.rs#L58 , #L86 , #L156-L159 |
| Loader v3 のアップグレード | ProgramData に `slot` と `upgrade_authority_address: Option<Pubkey>` を保持 https://github.com/anza-xyz/solana-sdk/blob/f5fd9ece3920419edb69eaf78fb896844b3cd971/loader-v3-interface/src/state.rs#L31-L33 。authority が None なら `Immutable`、同一スロットでの再アップグレードは拒否 https://github.com/anza-xyz/agave/blob/v3.1.9/programs/bpf_loader/src/lib.rs#L751-L761 。SetAuthority で None を渡すと不可逆に immutable 化 https://github.com/anza-xyz/agave/blob/v3.1.9/programs/bpf_loader/src/lib.rs#L835-L875 。CLI の `--final` は「アップグレード不可にする」 https://github.com/anza-xyz/agave/blob/v3.1.9/cli/src/program.rs#L243-L245 。デプロイ後の可視化は 1 スロット遅延 https://github.com/anza-xyz/agave/blob/v3.1.9/program-runtime/src/loaded_programs.rs#L32 |
| Loader v4 | feature `enable_loader_v4`（SIMD-0167）は v3.1.9 に存在 https://github.com/anza-xyz/agave/blob/v3.1.9/feature-set/src/lib.rs#L846-L847 , #L1805 。メインネットで有効かは**未確認** |
| 決定性 | 浮動小数点は LLVM のソフトウェアエミュレーションで、一部の演算のみ対応 https://solana.com/docs/programs/limitations （検索結果の要約で確認、本文は 429 で取得不可）。rent の計算は BPF 上で f64 を使わない分岐を持つ（rent/src/lib.rs #L150-L170）。時刻は Clock sysvar 経由のみで、乱数 syscall は存在しない、という一般命題は一次資料での**未確認** |

## 1. MagicBlock BOLT（commit 71906078）

| 観点 | 内容 |
|---|---|
| 権限 | World が持つ `authorities` が `approve_system` / `remove_system` を実行する。承認済み system が 0 件になると `permissionless = true` に戻る https://github.com/magicblock-labs/bolt/blob/719060783fe67a786cb179eab8d60ddfec7de25f/crates/programs/world/src/lib.rs#L140-L226 |
| 書き込み経路 | `apply_impl` は system が未承認なら `SystemNotApproved` を返す。system を CPI で呼び出し、戻り値 `Vec<Vec<u8>>` の件数が component 数と一致しなければ `InvalidSystemOutput`。World が各 component の `update` を CPI で呼ぶ（同ファイル #L385-L431） |
| component 側の検査 | `authority == World::id()` または署名者であることを要求。さらに instruction sysvar の現在のトップレベル命令が World であることを要求（`get_instruction_relative(0)`） https://github.com/magicblock-labs/bolt/blob/719060783fe67a786cb179eab8d60ddfec7de25f/crates/bolt-lang/attribute/bolt-program/src/lib.rs#L226-L232 。このため外部プログラム経由で World を呼ぶ合成は不可、と推測される（**未確認**） |
| 停止権限 | component の破棄は component authority またはプログラムの upgrade authority（同ファイル #L135-L146） |
| バージョン管理 | system・component は個別の upgradeable program。内容ハッシュによる固定は無し（コード上に該当なし） |

## 2. Metaplex Core（commit a5c35db4）

| 観点 | 内容 |
|---|---|
| 検証結果 | `Approved / Rejected / Pass / ForceApproved` https://github.com/metaplex-foundation/mpl-core/blob/a5c35db436fdb6382ac75b1d59205d769c4762ea/programs/mpl-core/src/plugins/lifecycle.rs#L436-L445 |
| 外部アダプタ | LifecycleHook / Oracle / AppData / LinkedLifecycleHook / LinkedAppData / DataSection / AgentIdentity https://github.com/metaplex-foundation/mpl-core/blob/a5c35db436fdb6382ac75b1d59205d769c4762ea/programs/mpl-core/src/plugins/external_plugin_adapters.rs#L124-L150 。Linked 系は collection 専用 https://github.com/metaplex-foundation/mpl-core/blob/a5c35db436fdb6382ac75b1d59205d769c4762ea/programs/mpl-core/src/processor/add_external_plugin_adapter.rs#L55-L58 |
| Oracle | **CPI を使わない**。外部アカウントのデータを offset から `OracleValidation::V1{create, transfer, burn, update}` として読むだけ。Execute は常に Pass https://github.com/metaplex-foundation/mpl-core/blob/a5c35db436fdb6382ac75b1d59205d769c4762ea/programs/mpl-core/src/plugins/external/oracle.rs#L90-L120 。ドキュメント上は「Can Reject」のみ対応 https://metaplex.com/docs/core/external-plugins/oracle |
| LifecycleHook | 現行コードの `validate_*` は abstain（Pass）だけを返し、hook プログラムへの CPI は実装されていない https://github.com/metaplex-foundation/mpl-core/blob/a5c35db436fdb6382ac75b1d59205d769c4762ea/programs/mpl-core/src/plugins/external/lifecycle_hook.rs#L41-L55 。対象イベントは init 時に宣言したもの（Create/Transfer/Update/Burn）に限られる（external_plugin_adapters.rs #L196-L232） |
| AppData | 書き込めるのは Data Authority だけ。Update Authority であっても Data Authority でなければ書けない https://metaplex.com/docs/core/external-plugins/overview |
| mint/burn | 外部アダプタはアセットの発行・焼却を実行できず、拒否票を出すことしかできない（上記の構造から推論） |

## 3. SPL Transfer Hook（transfer-hook 2ff5ea9a / token-2022 e5cbf628）

| 観点 | 内容 |
|---|---|
| 権限の降格 | `Execute` 命令は source / mint / destination / authority をすべて **readonly かつ非署名者**で渡す https://github.com/solana-program/transfer-hook/blob/2ff5ea9aec5034f0bcdb9e6dbf86ec6f0b6c6da9/interface/src/instruction.rs#L183-L196 |
| 追加アカウント | PDA `ExtraAccountMetaList`（mint と hook program から導出）を解決して CPI に追加 https://github.com/solana-program/transfer-hook/blob/2ff5ea9aec5034f0bcdb9e6dbf86ec6f0b6c6da9/interface/src/onchain.rs#L15-L55 |
| 呼び出し中フラグ | token-2022 は CPI の前に source / destination に `transferring` を立て、後で外す。hook はこのフラグで「transfer 中の呼び出し」かを確認できる https://github.com/solana-program/token-2022/blob/e5cbf62819c87980228886255e7788761b9558df/program/src/processor.rs#L610-L633 |
| hook にできないこと | 権限が降格されているため、元の authority 署名でトークンを動かすことも、token アカウントを書き換えることもできない。hook にできるのは失敗させることと、自分が所有する extra account への書き込みのみ |

## 4. MUD（commit 0e49b51b）

| 観点 | 内容 |
|---|---|
| アクセス制御 | 名前空間単位または resource 単位の `ResourceAccess`。所有者判定は `NamespaceOwner` https://github.com/latticexyz/mud/blob/0e49b51ba934438e49c7f098e78d6e3ddf7567fb/packages/world/src/AccessControl.sol#L26-L30 , #L78-L80 。`setRecord` などは `_requireAccess` を要求 https://github.com/latticexyz/mud/blob/0e49b51ba934438e49c7f098e78d6e3ddf7567fb/packages/world/src/World.sol#L137-L145 |
| system 登録・更新 | 名前空間の所有者だけが `registerSystem(id, system, publicAccess)` を呼べる。同じ id で再登録すると旧 system のアクセス権を消して差し替える（これが upgrade の仕組み）。root namespace の system は delegatecall で実行される https://github.com/latticexyz/mud/blob/0e49b51ba934438e49c7f098e78d6e3ddf7567fb/packages/world/src/modules/init/implementations/WorldRegistrationSystem.sol#L130-L173 |
| hooks | `registerSystemHook`（呼び出しの前後）は system の所有者のみ登録可（同ファイル #L77-L97） |
| 委任 | `callFrom` を使う。`UNLIMITED_DELEGATION` は特別な定数 id https://github.com/latticexyz/mud/blob/0e49b51ba934438e49c7f098e78d6e3ddf7567fb/packages/world/src/constants.sol#L23 , https://github.com/latticexyz/mud/blob/0e49b51ba934438e49c7f098e78d6e3ddf7567fb/packages/world/src/Delegation.sol#L29-L31 。CallboundDelegation は (delegatee, systemId, callData) の組み合わせに呼び出し回数を割り当て、呼ぶたびに減算する https://github.com/latticexyz/mud/blob/0e49b51ba934438e49c7f098e78d6e3ddf7567fb/packages/world-modules/src/modules/std-delegations/CallboundDelegationControl.sol#L16-L61 （UserDelegationControl テーブルの行番号は**未確認**） |
| インデクサ | Store が汎用の `Store_SetRecord` 系イベントを出し、スキーマはオンチェーンのテーブルにあるため、未知のテーブルも汎用にデコードできる（**未確認**、行番号なし） |

## 5. Dojo（commit 19c258a3）

| 観点 | 内容 |
|---|---|
| 権限 | Owner と Writer の 2 段階。判定順は resource → world owner → 名前空間 https://github.com/dojoengine/dojo/blob/19c258a3c62719015c2528cda88ea756a7cfbb7f/crates/dojo/core/src/world/world_contract.cairo#L1216-L1245 。grant/revoke は Owner だけ（同 #L421-L470）。`set_entity` には Writer が必要（同 #L1069-L1078） |
| upgrade | `upgrade_model` は Owner が実行し、`assert_resource_upgradability` を通す（同 #L629-L687 , #L1289） |
| スキーマ規則 | struct は名前と attrs が不変で、メンバーは**末尾追加のみ**。既存メンバーは各々が upgrade 互換である必要がある https://github.com/dojoengine/dojo/blob/19c258a3c62719015c2528cda88ea756a7cfbb7f/crates/dojo/core/src/meta/introspect.cairo#L386-L425 |
| インデクサ | Torii が world の汎用イベントを解釈する（**未確認**） |

## 6. Solana 上のプログラム内インタプリタ / ポリシー

| プロジェクト | 内容 |
|---|---|
| Swig（c81d450f） | 役割ごとの閉じた `Permission` enum: SolLimit / SolRecurringLimit / Program / ProgramScope / TokenLimit / All / ManageAuthority / SubAccount / StakeLimit / ProgramAll / ProgramCurated / SolDestinationLimit など https://github.com/anagrambuild/swig-wallet/blob/c81d450f37a7613425a7fd3fabef0c38e083c0a9/state/src/action/mod.rs#L129-L169 。CPI の前に writable アカウントのハッシュと残高を snapshot し（最大 100 件）、CPI 後に比較して制限を強制する https://github.com/anagrambuild/swig-wallet/blob/c81d450f37a7613425a7fd3fabef0c38e083c0a9/program/src/actions/sign_v2.rs#L116-L117 , #L347-L410 |
| Lighthouse（4c579479） | 閉じた assertion 命令群（AccountData / AccountDelta / AccountInfo / Mint / Token / Stake / UpgradeableLoader / SysvarClock / MerkleTree …）と MemoryWrite（自身が所有する memory アカウントのみ）を持つ https://github.com/Jac0xb/lighthouse/blob/4c579479c98635e419b1b167f08be02a71604a71/programs/lighthouse/src/instruction.rs#L31-L93 。演算子は固定の 8 種類で、未知のコードは `InvalidInstructionData` https://github.com/Jac0xb/lighthouse/blob/4c579479c98635e419b1b167f08be02a71604a71/programs/lighthouse/src/types/assert/operator.rs#L21-L45 |
| Squads のポリシー / 汎用オンチェーンスクリプト | **未確認**（今回は調査せず） |

## WYLLS への含意（要約）

- **(B) 宣言的拡張に最も近い先例は Lighthouse・Swig・Metaplex Oracle の 3 つ。** いずれも閉じた enum と固定演算子を使い、未知のコードは即エラーにする。CPI を使わない（Oracle の場合はデータ読み取りのみ）ため、5 段の CPI 深さや再入禁止の制約を受けない。
- **(C) 外部 CPI 型では、Transfer Hook の権限降格と BOLT の「World 経由のみ書き込み可」が標準的な防御策。** ただし 3.1.x のメインネットでは CPI 深さ 5 と A→B→A の再入禁止が効くため、hook からコアへ書き戻す設計は成立しない。
- **バージョン固定について。** 内容ハッシュによる固定を持つ先例は見当たらなかった。BOLT・MUD・Dojo はいずれも authority / owner による差し替え方式を取る。Dojo の append-only スキーマ規則は、(B) のマニフェストを更新するときの互換規則として参考になる。
