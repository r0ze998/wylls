# ⑪(b) Declarative extension effects: implementation plan (2026-11-28)

> **要約（日本語）。** ⑪(b) は「拡張を**コードではなくデータ**で書き、コアが閉じた語彙だけを解釈する」方式です（所有者の決定 2026-11-18「(b) は最初の遊べる devnet の後」。devnet の world 3 が 11-26 から遊べるので着手可能）。ホスト上の試作 `workstreams/11-extensions/ext-kernel` は 10-30〜11-08 に完成していますが、コア（規則カーネル・program・検証器）には一行も入っていませんでした。今回、規則カーネル `permutation-rules` に**機能フラグ `declarative-effects`（既定で無効）**の最初の切片を入れました：効果 2 つ（`Lock` 預け入れ・`Release` 返却）と状態の op 3 つ、検証器側の再実行 `replay`、試作との一致の試験。program・口座・タグ・版・ハッシュはどれも変えていません。チェーン上で使うには program の変更（タグ 0xE8–0xED、口座 27–30、記録 135–144、版のビット）が要り、**r0ze の OK と world 4 の判断**が要ります。未決の点は `inbox/2026-11-28-1625-item11b-questions.md`。

Code wins over this document. Base: `origin/main` `29dc7e695` (merged up to `ead5ac42c` in verify-pr317).

> **Owner answers (r0ze, 2026-11-28 19:45 JST, `inbox/2026-11-28-1945-r0ze-1800-answers.md`).**
> **Q-11B-1 = A:** ⑪(b) goes into the **world-4 upgrade** (with ④⑨⑩②), starting with a small **Lock/Release-only** version (Require/Set/Add + Lock/Release; no Burn, no Emit record). **Q-11B-2 = A:** **no Burn in v1** — extensions only escrow and return; the resource total never changes. Burn is not planned (it could only come as a later, separately decided effect set). Still open: Q-11B-3 (dormancy), Q-11B-4 (publish/activate/stop authority), Q-11B-5 (page text) — they affect the program/page slices, not this flag-off kernel slice. The world-4 scope is a plan decision, not a deploy approval: any program build, devnet deploy or SOL still needs r0ze's confirmation.
>
> **所有者の回答（11-28 19:45）：** Q-11B-1 = A（world 4 の upgrade に入れる。最初は Lock/Release だけの小さな版）、Q-11B-2 = A（v1 に Burn は無い。預け入れと返却だけ）。Q-11B-3〜5 は未回答。

## 1. What "declarative effects" means here

An extension is a **manifest**: declared per-user state (≤ 8 bounded `i64` fields) and ≤ 4 entries, each a straight list of ≤ 32 ops from a **closed vocabulary** the core interprets. The author's code never runs. Identity is the SHA-256 of the canonical bytes, so an update is a new id and a user's grant stays pinned to the old meaning (workstream 11 contract, `workstreams/11-extensions/01-contract.ja.md`).

"Effect" = an op that changes something the core owns. Everything else is a guard or extension-local state:

| class | op (code) | meaning | in slice 1 |
|---|---|---|---|
| guard | `Require(cmp, a, b)` 0x01 | false → the whole call is refused, nothing written | yes |
| ext state | `Set(f, x)` 0x02, `Add(f, x)` 0x03 | write the caller's own field (checked, `min..=max`) | yes |
| **core effect** | **`Lock(res, x)`** 0x04 (ext-kernel `Pay`) | caller's own Holding → caller's escrow under this extension (`Holding::pay`), per-call `pay_cap` | **yes** |
| **core effect** | **`Release(res, x)`** 0x05 (ext-kernel `Refund`) | that escrow → the same Holding (`Holding::credit`), never more than escrowed | **yes** |
| core effect | `Burn(res, x)` 0x06 | consume from the Holding | **no, and not in v1 at all** (Q-11B-2 = A): refused as `NotInSlice` |
| log | `Emit(code)` 0x07 | one record byte | no: needs a record kind (program) |

Operands: constant, argument (declared range), field, `now_bell` (= `now_ts.div_euclid(600)`, absolute time, not season-relative), escrow. No branch, loop, call-out, mint, randomness or read of another account: a run is ≤ 32 constant-time steps and a pure function of (body, entry, args, now_ts, instance, Holding).

What it **cannot** express (by design, effect set 1): touching anyone else's Holding/escrow, minting, reading provinces/nations/other extensions, calling core instructions. Lock+Release conserve Holding+escrow exactly (tested exhaustively over short histories).

### Prior art (compared in `workstreams/11-extensions/10-research.ja.md`)

- **Lighthouse** (github.com/Jac0xb/lighthouse) and **Swig** (github.com/anagrambuild/swig-wallet): closed enums of assertions/actions interpreted by one program; unknown codes refused → our closed op set + `UnknownOp`.
- **MUD** (github.com/latticexyz/mud) / **Dojo** (github.com/dojoengine/dojo): systems are code swapped by an authority → rejected (meaning can change silently; verifier would need the code).
- **BOLT** (github.com/magicblock-labs/bolt): components/systems via CPI → option C, rejected for now (reentrancy, CPI depth, third-party `.so` to re-execute).
- **Token-2022 Transfer Hook**: core calls out with downgraded privileges → same C-type costs.

Content-hash pinning (id = hash of bytes) had no direct precedent there; it is what makes "update = new id" structural.

## 2. Where effects are evaluated

| layer | role | state today | change needed |
|---|---|---|---|
| **rules kernel** `permutation-rules::frontier::effects` | the ONE interpreter (`run`) and replay (`replay`); no_std, linked by everything below | **slice 1 on this branch**, feature `declarative-effects`, off by default | none on-chain |
| ext-kernel prototype `workstreams/11-extensions/ext-kernel` | registry, grants, receipts, buffer, exit, verifier (host) | complete host prototype; now cross-checked against the kernel (`tests/kernel_slice.rs`) | slice 2: make its `exec` a wrapper of the kernel module (one interpreter) |
| **program** `permutation-frontier` | `ExtWriteManifest/Publish/SetStatus/Grant/Call/Withdraw` on 0xE8–0xED, accounts ExtRegistration/Grant/Instance/Buffer (AccountKind 27–30), records EXT_* 135–137 (`frontier-abi/src/feature_registry.rs` reserves them; `patches/0002`) | **not started** | **program change → r0ze OK + world-4 decision** |
| **page / AI** `frontier-wasm` + web | show `describe` (what a manifest can take, from its bytes alone) before a grant; dry-run `run` for a preview | none | wasm export behind its own feature; the committed WASM modules must not change (`build-wasm --check`) until adopted |
| **verifier** `frontier-node/crates/verify` | see §3 | tag band 0xE8–0xED is unknown → V0 FAIL under a known version, UNVERIFIABLE otherwise (correct: never PASS) | new check + knowing the band once the program ships |

## 3. How the verifier checks them (VX / VG + a native check)

1. **VX / VG already cover it once the interpreter is inside the program.** VX re-executes playable-lane transactions on the **pinned `.so`** from archived pre-states; VG re-executes the whole history from genesis on the pinned `.so` (M1-CONTRACT §V-table). An `ExtCall` is just another program instruction: re-running the pinned binary re-runs the interpreter, so a forged Holding/escrow delta is `ReExecMismatch`, a refused call claimed as success is `ReExecRefused`. Required: add the Ext tags to VX's `native_of`/coverage list so they are re-executed rather than left to V0.
2. **A native check "VE"** (independent of the `.so`, like the VWL ports): `frontier::effects::replay` over the archived registration bytes, instance pre/post states and Holding deltas. Verdicts: unknown body bytes / unknown op or effect set / missing finals → **UNVERIFIABLE**; hash mismatch, seq replay, rules refuse, delta or final-state mismatch → **FAIL**; else PASS. The slice already implements and tests this function (`lock_then_release_end_to_end`, `closed_vocabulary_and_publication_checks`: every one of the 251 non-slice op codes is UNVERIFIABLE, never PASS).
3. Registry history (paused/revoked windows) and grant updates are judged by ext-kernel's verifier rules (contract §3, §6), to be ported in slice 3.
4. Unchanged holes that matter here: CPI inner instructions are still UNVERIFIABLE (③ 0002 needs `innerInstructions`); the interpreter does no CPI, so ExtCall is top-level only.

## 4. Migration and versioning

- **Effect set** (`u8`, manifest header) names the vocabulary. ext-kernel's effect set 1 = Require/Set/Add/Pay(Lock)/Refund(Release)/Burn/Emit; the **world-4 v1 vocabulary is Require/Set/Add/Lock/Release only** (Q-11B-1/2 = A: Burn excluded; Emit needs a record kind and is not in the Lock/Release-only first version). Slice 1 implements exactly that subset and reports the rest as `NotInSlice` (distinct from `UnknownOp`), so the format never forks. Adding ops = a new effect set; old manifests keep their meaning; an old verifier says UNVERIFIABLE for a new set.
- **Body bytes** = WXM1 after its header, byte-identical (tested). The header (magic, schema, effect set, core version, author, name) stays with the registry (program side).
- **Core pin.** A manifest pins `{program_version, ruleset_hash}`; a mismatch stops calls and opens the exit. ext-kernel pins S1 (`PROGRAM_VERSION_S1` = 4, `RULESET_HASH_V3`), but the live world 3 runs the playable lane (version 0x4804) → the pin must name the lane's version (part of Q-11B-1). An Ext build also needs a program-version bit; `feature_registry` reserves tags/records/kinds for Ext but **no version bit** (Q-11B-1).
- **Continuing world.** Accounts keyed by a root that does not change per season and by the owner's stable identity; the exit (`Withdraw`) is never closed by season state (r4, `09-continuing-world.ja.md`).
- **Kernel feature → adoption.** `declarative-effects` stays off and outside `KERNEL_VERSIONS`/the ruleset hash (guarded by `frontier_shared.rs` `ruleset_hash_binds_versions_and_catalog`) until a build gives it a version. Binding it then is a ruleset-hash change = a new world (world 4) by the same rule the other previews follow.

## 5. What needs an on-chain program change (world 4 = Q-11B-1 A; each build/deploy still needs r0ze's OK)

| item | why it is on-chain |
|---|---|
| Ext instructions 0xE8–0xED, accounts 27–30, records 135–137 | registry, grant, call and withdraw must be enforced by the program to be anything but a local toy |
| a program-version bit for Ext and the manifest's core pin = the lane's version | seasons with extensions must never mix with ones without |
| binding `frontier::effects` into `KERNEL_VERSIONS` / ruleset hash | changes `RULESET_HASH` |
| who may publish / activate, emergency-stop authority (D4/D5 = Q-11B-4) | program authority checks |
| rent payers (author for registration, user for grant/instance) and instance close | SOL flows |
| CU / size measurement on SBF (T1/T2) | needs an SBF build (allowed only with a brief that permits it) |

## 6. What can be local-only now (no OK needed)

1. **Slice 1 (this PR):** kernel module + 4 kernel tests + 2 parity tests + 1 randomized parity/replay test (`kernel_slice_random.rs`, verify-pr317: 3,000 random manifests) + CI lines. Off by default; no program, page, gateway or verifier code reads it.
2. **Slice 2:** ext-kernel's `exec::run_entry` delegates to `frontier::effects::run` (one interpreter); Emit stays out of the world-4 v1 (event list only, if ever); **no Burn port** (Q-11B-2 = A).
3. **Slice 3:** `frontier-node/crates/verify` native check VE (feature-gated, fixtures from ext-kernel's histories, never PASS on unknown).
4. **Slice 4:** page preview: `describe` + dry-run in a separate wasm feature; English-first text; no committed module changes.
5. **Slice 5 (needs OK):** program handlers on 0xE8–0xED in a localnet-only lane with its own marker, then LiteSVM, then the world-4 upgrade (Q-11B-1 = A; Q-11B-4 authority must be answered before the handlers are written).

## 7. Risks

- The interpreter becomes core: an interpreter bug is a core bug (one implementation, two consumers, tested for parity).
- `Holding::credit` may exceed the storage cap (refunds are allowed to); a Release onto a full store is kept, not lost (rule of `Accrual::add`).
- Extensions as "owner actions" (dormancy clock) are deliberately not touched (D3 = Q-11B-3).
