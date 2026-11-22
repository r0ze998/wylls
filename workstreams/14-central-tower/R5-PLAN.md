# ⑭ R5 — a dense host index with no centre: plan for after the first devnet season

Status: **design only, nothing merged by this document.** Base: `origin/main` 8e76a538 (2026-11-22).
Devnet deploy candidate: `devnet-playable-sbf` `.so` `67a33c92…06b3` (`docs/frontier/devnet/DEVNET-DEPLOY-RUNBOOK.md` §1a).
Nothing below changes that `.so`, its ABI or any ruleset hash unless a section says "on chain, next season".

Earlier record: `rules-r3-r5-design.md` §3 (Grok reports) deferred R5 as "ABI break, effectively never for the
legacy ≤ 128 lattice". This plan re-reads the code on current main and splits R5 into pieces that can be decided
one at a time.

## 要約（日本語）

- **何が変わるか:** 中心 (0,0) からの「輪の順番」で番号を振る密な州番号 `ProvinceCoord::index` が、ホスト ID の上位 20 ビット、
  州の支配ファイル（PSFCT1）、⑰ 賞金の集計ビットマップに入っている。プレイヤーに見える偏りは 1 つだけ：
  **同じ兵数のとき「番号の小さいホスト」が勝つ**（砦の明け渡し先とDeclareSiegeの先導ホスト）。番号が小さい＝(0,0) に近い州。
  広い土地のキー（`WideHostRef`）も同じ輪の順で並ぶので、同じ偏りがある。
- **devnet 前にできること（.so も ABI も変えない）:** herald の支配ファイルを「開いた州だけ」の疎な形式で出す
  （輪 126 の縁の季節で 1 ベルあたり約 390 KB → 開いた州の数 × 約 12 B、広い土地も入る）、ページの読み込みを輪ごとから
  座標の塊ごとへ、keeper の同点の並びから輪を外す。プレイヤーに効くのは「縁・広い土地で遊ぶ人の読み込みと、
  支配・順位表が輪 127 で止まる問題」。
- **後でやること（最初の devnet 季節のあと、次の .so）:** R5a＝同点の決め方を「番号の小さい順」から
  「そのベルのビーコン値で混ぜた順」へ。R3 と同じく季節パラメータの予約バイト 83 で切り替える（ルールセットの
  ハッシュは変えない、口座の形も変えない、走っている季節はそのまま、CU はほぼ 0）。
  R5b＝ホスト ID の州番号を「開いた順」に変える案は、チェーン上でホスト ID から (P,Q) を戻している箇所が多く、
  ABI の作り直しになる。⑰ の賞金を広い土地まで数えたいとき以外は勧めない。
- **費用:** R5a は約 1 PR（カーネル・verifier・sim・エージェントの 4 か所、CU 増は 1 比較あたり数 CU、
  G1 の余裕 853 CU 内）。R5b は ABI 全体（プログラムの約 50 呼び出し、ウェブ 51 ファイル、全フィクスチャ）で数週間。
- **r0ze に聞くこと:** Q1 R5a を次の季節で入れるか、Q2 ⑰ の賞金を輪 17 の外（広い土地）まで広げたいか（R5b か
  ⑰ 側の別案が要る）、Q3 herald の疎な支配ファイルを devnet 前に入れてよいか。

---

## 1. What R5 touches today (file:line at 8e76a538)

### 1.1 The index itself

| Where | What |
|---|---|
| `permutation-rules/src/frontier/geometry.rs:146-147` | `CONCORD = (0,0)`, doc still "The Concord, ring 0" after R2 made (0,0) ordinary land in centre-free seasons |
| `geometry.rs:270-292` | `ProvinceCoord::index`: ring 0 = 0, ring d from `1 + 3d(d−1)`, wedge by wedge; `u32::MAX` past ring 128 |
| `geometry.rs:293-318` | `from_index` (inverse) |
| `permutation-rules/src/frontier/addr.rs:410-469` | `host_id = index << 44 \| site << 40 \| gen << 32 \| seq`; `host_parts` splits it back to (P,Q) |
| `frontier-abi/src/addr.rs:244-285` | `host_id`, `split_host_id`, `holding_key_of_host`, `province_index` (the ABI's copies) |
| `permutation-server/web/frontier/fgeo.mjs:42-60` | JS mirror `provinceIndex` / `provinceFromIndex`; 51 non-test web files use index or host-id helpers |

Account addresses are **not** keyed by the index: Province, Holding, ArrivalSlot, ClashInputs, Posture are
`with_seed(… P ‖ Q …)` (`addr.rs:320-366`). The only seed that takes a host id is the reserved
`seal_verdict_reserved` (`addr.rs:369`).

### 1.2 Where the index's *order* decides an outcome (the only player-visible centre bias)

The clash already ranks by hashed tie keys (`clash.rs` module doc l.90-106; `build_units` `clash.rs:1361`
sorts by id only to make array positions; `slot_rank` `clash.rs:2314` and `quota_set` `clash.rs:2411` use the
id after a 64-bit hash, so only on a hash collision). What still reads the raw id order:

| Rule | Code | Effect |
|---|---|---|
| Keep donor (who takes a keep's troops when its contender holds it) | `permutation-rules/src/frontier/keep.rs:344-366` `lead_host` / `lead_pos` ("most troops, then the **lowest host id**"); called from `frontier-abi/src/conquest_model.rs:516-528` (Resolve step 3) | With equal troops, the host whose home province is nearer (0,0) wins. Musters come in round numbers (100-troop units), so exact ties are realistic. |
| DeclareSiege lead host | `frontier-abi/src/v2/entry.rs:70-75` → `permutation-frontier/src/proc/conquest.rs:716`; verifier `frontier-node/crates/verify/src/checks/v14_sieges.rs:303` | Same tie. Not in the devnet `.so` (P14 b removed conquest kinds 12–18), live in localnet conquest lanes. |
| Wide keep donor | `frontier-abi/src/world_index/resolve.rs:1003` `advance_with` over `WideHostRef` | `WideHostRef`'s `Ord` is `ProvinceKey` then site/gen/seq (`world_index/key.rs:109,166`); `ProvinceKey` orders by `WideCoord`, whose `Ord` is **ring from (0,0), wedge, position** (`world_index/coord.rs:12-18, 259-264`). Same centre bias on wide land. |
| Mirrors | `frontier-node/crates/agents/src/cqbehave.rs:140`, `frontier-sim/src/sim_mc.rs:429` | bots / sim pick the lead the same way |

Kernel versions: `KEEP_VERSION` 2 / `KEEP_VERSION_CENTRE_FREE` 3 (`keep.rs:49,53`; in `KERNEL_VERSIONS_V3`
`permutation-rules/src/frontier/mod.rs:393`, which V4 copies, `mod.rs:453`).

### 1.3 Where the index is a storage position (no bias, but a size/reach limit)

| Consumer | Code | Limit today |
|---|---|---|
| Herald control file `PSFCT1` (8 B per province, dense rings 0..=R) | `frontier-node/crates/herald/src/cqfmt.rs:24-26, 131-132`; `control.rs:327-330, 412-415`; web `herald.mjs:570, 583-591` | R ≤ 127. A devnet-wide season with rim homes at ring ≥ 126 ships `provinces_within(127)` = 48,769 records ≈ **390 KB per bell**, almost all "unopened" (code 7); wide land (ring ≥ 129) is never in it (memory: wide herald control/standings frozen). |
| Herald ring-paged routes | `/h/overview/{ring}`, `/h/overview2/{d}`, `/h/roster/{d}`, `/h/world/ring/{d}` (herald `src/*.rs`) | A page far from (0,0) still walks rings to find its land. Wide land has its own sparse `/h/world/wide/page`. |
| ⑰ prize tally bitmap | `permutation-prize/src/lib.rs:98-102` (`MAX_PROVINCES` 1,024, `MAX_RING` 17), `epoch.rs:409-412`, InitPool refusals `lib.rs:1274-1283` (`CeilingPastTally` 0x111) | `S1_DEVNET_WIDE_7D` has `r_max_ceiling` 128 (`frontier-abi/src/v2/presets.rs:842, 852`), so **InitPool refuses the playable devnet season**. Owner default (t353u): prize scope ring ≤ 17. |
| On-chain split back | `split_host_id` in `frontier-abi/src/log.rs:570`, `v2/log.rs:655` (event entity addresses), `permutation-frontier/src/proc/{caravan,conquest,transit,host,structure,clash,holding,citizen}.rs` (≈ 26 uses) | The program turns a stored host id back into (P,Q) to derive accounts. Any index that is not a pure function of (P,Q) breaks this. |
| Wide host identity | `world_index/march.rs:105,122` (`HOST_ALIAS_BIT`, `wide_host_alias`), `world_index/roster.rs` (3,248 B side table per wide province, a separate with-seed account) | Exists *because* the 20-bit index stops at ring 128. |

### 1.4 Off-chain order (policy only)

- Keeper `provinces_reach` order `(distance, ring, p, q)` — `frontier-node/crates/keeper/src/rings.rs:298`.
  Ring is a tie-break after distance-to-settlement: provinces nearer (0,0) open first on a tie.
- Everything else in the keeper keys provinces by `(i32, i32)` in `BTreeSet`/`BTreeMap` (lexicographic P then Q,
  not centred).

## 2. OSS references: dense ids for an unbounded / centre-free space

| Project | File | How ids are made | Fit |
|---|---|---|---|
| [uber/h3](https://github.com/uber/h3) | [`src/h3lib/include/h3Index.h`](https://github.com/uber/h3/blob/master/src/h3lib/include/h3Index.h) | 64-bit cell id: mode, resolution (bits 52..), **base cell** (7 bits at 45, 122 cells), then 3-bit digits per resolution. Hierarchical; no single origin, but base cells are numbered from a fixed table. | Shows a 64-bit hex id with no "centre", but needs a hierarchy; our lattice is flat. Ordering by id still prefers low base cells. |
| [google/s2geometry](https://github.com/google/s2geometry) | [`src/s2/s2cell_id.h`](https://github.com/google/s2geometry/blob/master/src/s2/s2cell_id.h) | face (3 bits) + position along a **Hilbert curve**: locality-preserving, dense in a finite domain. | Good for "load what is near me" (range scans), but on an infinite plane any curve still has a start: small numbers sit somewhere. |
| [orlp/slotmap](https://github.com/orlp/slotmap) | [`src/lib.rs`](https://github.com/orlp/slotmap/blob/master/src/lib.rs) | dense slot index **in insertion order** + version (ABA guard). | The "open-order index" idea (R5b): dense over what exists, no geometry. Our host id already has a `gen` byte like slotmap's version. |
| [bevyengine/bevy](https://github.com/bevyengine/bevy) | [`crates/bevy_ecs/src/entity/mod.rs`](https://github.com/bevyengine/bevy/blob/main/crates/bevy_ecs/src/entity/mod.rs) | `Entity` = index + generation, recycled indices. | Same as slotmap; confirms the lookup cost: an id no longer tells you *where*, so every reader needs an index → place table. |
| [CleverRaven/Cataclysm-DDA](https://github.com/CleverRaven/Cataclysm-DDA) | [`src/overmapbuffer.cpp`](https://github.com/CleverRaven/Cataclysm-DDA/blob/master/src/overmapbuffer.cpp) | infinite map in chunks keyed by absolute chunk coordinates, made on demand. | The off-chain part (§3): serve land by coordinate chunk, not by ring. |

What they share: **a dense id is dense over something** — a finite face (S2), a fixed base table (H3) or the set
of things that exist (slotmap/bevy). On an infinite plane the only dense, centre-free choice is "the things that
exist" (open order), and it costs the "id tells you where" property. Order fairness is solved separately:
games and ECSs never use id order as a gameplay tie-break; they use a seeded random key (our clash already does).

## 3. What can land WITHOUT changing the devnet `.so` or ABI (before or during the first devnet season)

All three are off-chain; none changes a hash, a layout, an instruction or a fixture the program reads.

| # | Change | Where | What players get |
|---|---|---|---|
| H1 | **Sparse control file** `PSFCT2`: a list of `(P i32, Q i32, record 8 B)` (≈ 16 B) for **opened provinces only**, in `(P,Q)` or open-bell order, served next to `PSFCT1` (`/h/control2/{bell}.bin`); WS delta keyed by `(P,Q)`. Rings past 127 (rim, wide) included. Keep PSFCT1 unchanged for old readers. | herald `cqfmt.rs`, `control.rs`, `standings.rs`; page `herald.mjs` decoder; vectors in `frontier-node/fixtures/cq/formats/` | Rim/wide players: control colours and standings stop freezing at ring 127; a rim season's control file drops from ≈ 390 KB/bell to `opened × 16 B` (e.g. 300 opened provinces ≈ 5 KB). |
| H2 | **Coordinate-chunk province route** `/h/chunk/{cp},{cq}` (chunk = 8×8 provinces, CDDA style) over legacy + wide provinces; page map/全体図 loads chunks in view instead of `/h/world/ring/{d}` walks. | herald routes; page `map/world.mjs`, `map/wide.mjs` | Opening the map near a rim or wide home costs what is in view, not every ring from (0,0); one code path for legacy and wide land on the page. |
| H3 | Keeper `provinces_reach` tie-break: `(distance, hash(season ‖ P ‖ Q))` instead of `(distance, ring, p, q)`. | `keeper/src/rings.rs:298` (+ its test at `rings.rs:1035-1311`) | Province openings on demand no longer favour the side nearer (0,0) on ties. Small. |

Cost/risk: H1 is the largest (a new binary format with shared Rust/JS vectors, the CF-x discipline in
`cqfmt.rs` l.1-50); H2 needs a Playwright check of the map; H3 is a few lines. None needs cargo-build-sbf, a
re-pin of `.so`/wasm hashes, or the verifier. H1/H2 are UI-visible, so they follow the usual merge gate
(CI + independent Playwright play-through). They do **not** remove the on-chain tie bias (§4).

Not possible off-chain: changing who wins a tie (consensus, verifier re-runs it), widening the prize bitmap.

## 4. On chain, next season: a versioned change after the first devnet season

### 4.1 R5a — centre-free tie order (recommended)

**Rule:** where the kernel says "most troops, then the lowest host id", use "most troops, then the lowest
`id XOR m_b`", where `m_b` = the first 8 bytes of that bell's clash seed (drand-anchored, unknown before the
round; `clash_seed` / `wide_clash_seed` already computed in the same Resolve). For any two hosts the winner of a
tie is decided by one bit of `m_b`: 50/50 per bell, no direction, no grinding (the seed is the beacon's).
Wide: the same with `m_b` XORed into the first 8 bytes of the `WideHostRef` bytes, then the rest of the bytes as
today (keeps it a strict total order).

**Gate: a season parameter byte, not a ruleset hash (the R3 precedent).** The program accepts exactly one
ruleset hash per build (`permutation-frontier/src/lib.rs:210-212`), so a new kernel hash would make the upgraded
program refuse the running first devnet season. R3 avoided that with conquest byte 82 `spawn_reach`
(`frontier-abi/src/v2/presets.rs:62`); R5a takes the next reserved byte, **byte 83 `tie_order`**
(`RSV @ 83` → `@ 84`, 44 B): 0 = lowest host id (today, every existing and MC/TEST preset), 1 = beacon-masked.
An old `.so` refuses a season with byte 83 ≠ 0 (reserved byte check), so nothing is silently reinterpreted;
the new `.so` runs byte-0 seasons exactly as before.

| Piece | Change |
|---|---|
| `permutation-rules/src/frontier/keep.rs:344-366` | add `lead_host_masked(cands, m_b)` next to `lead_host`; byte 0 keeps calling `lead_host` (outcome unchanged → `KEEP_VERSION*` and `RULESET_HASH_V2/V3/V4` unchanged, as for R3) |
| `frontier-abi/src/v2/presets.rs:55-63, 200-230` | field `tie_order`, `validate` (≤ 1; 1 needs an S1 season), set to 1 in the playable presets (`centreless()`) only → their `params_hash` vectors change |
| `frontier-abi/src/conquest_model.rs:495-528` | `StepParams` carries `tie_order` + `m_b` from the Resolve (no new account) |
| `world_index/resolve.rs:1003` | wide `advance_with` with the masked order under byte 1 |
| DeclareSiege (`v2/entry.rs:70`, `proc/conquest.rs:716`, verifier `v14_sieges.rs:303`) | no Resolve seed at declaration. Option (i): the anchored beacon of the declaring bell (a new refusal while unanchored); (ii) keep lowest-id for DeclareSiege (it decides only who *leads*, not who gets troops). Recommend (ii); technical, inside Q1. |
| Verifier | reads byte 83 through `frontier_abi` like byte 82; shares the kernel function |
| Page `fcodec.mjs` | range check for byte 83 (generated reserved-byte check follows `layouts.json`) |
| Sim / bots | `sim_mc.rs:429`, `agents/cqbehave.rs:140` |

- **Migration:** none in place. The first devnet season (byte 83 = 0) can keep running on the upgraded `.so`;
  the next season is created with the new preset (byte 83 = 1). The upgrade itself still needs r0ze's `.so`
  approval and deploy (runbook §5a); a program upgrade during a live season is the operator's call, and is not
  required: the upgrade can wait for the season's end.
- **CU:** one XOR per comparison over ≤ `MAX_CANDIDATES` entries: < 100 CU. Budget evidence: G1-CQ heavy-keep
  worst 289,147 CU, margin 853 (verify-pr79); the masked compare fits with an order of magnitude to spare, but
  G1 must be re-measured (`svm-tests` G1 row): the keep path is exactly where the margin lives. Quiet wide
  Resolve ≈ 84,000 CU (verify-pr129) is unaffected.
- **Size / cost:** tens of bytes of `.so`. No account, layout, rent or fee change; deploy peak unchanged within
  noise (21.93 SOL at 5,080 for `67a33c92`, runbook §4a — a new `.so` must be re-measured).
- **Re-pins:** playable/devnet preset `params_hash` vectors, `.so` sha (new deploy approval), wasm `.hosts`
  (two CI rounds), `abi-vectors --check`, devnet profile `presets.json` drift guard. Ruleset hashes unchanged.

### 4.2 R5b — open-order dense index (not recommended unless Q2 = yes)

**Idea:** the province field of a host id becomes `fund wedge (3 bits) ‖ open sequence in that fund (17 bits)`,
assigned at OpenProvince from `ProvinceFund.PROVINCES_OPENED` (`frontier-abi/src/layout/world.rs:149`, already
counted per fund — OpenProvince writes no Frontier account by I-48, `permutation-frontier/src/proc/map.rs:620-622`,
so a global counter would add a write lock; the per-fund one does not) and stored in the Province's reserved tail
(`RSV @ 3864`, 232 B, `layout/province.rs:36`). Dense over *opened* land (6 × 131,072 = 786,432 provinces, any
distance), no ring cap, so legacy and wide hosts could share one `u64` id space.

| Gains | Costs |
|---|---|
| host ids past ring 128 → the wide alias/roster machinery could retire later (roster rent `(3,248 + 128) × rate` per mustering wide province = 0.0172 SOL at 5,080, 0.0235 at 6,960) | **the id no longer gives (P,Q)**: ≈ 26 on-chain `split_host_id` uses derive accounts from it (log entity addresses `log.rs:570`, `v2/log.rs:655`, caravans, conquest, transit). Each needs (P,Q) in instruction data + a check against the Province's stored sequence → instruction ABI change for most host-bearing instructions |
| PSFCT1/overview could become arrays over opened provinces (H1 does this off-chain already) | every stored host id in Province entries (56 × 8 B), march/transit records, ArrivalSlot/ClashInputs, events changes meaning → new layout version, no migration of a live season |
| prize bitmap by open sequence → wide land tallyable (needs `MAX_PROVINCES` raise or a bitmap per fund) | ~50 program call sites of `host_id(` in 18 proc files, 55 keeper, 29 fclient, 18 herald, 18 verifier, 51 web files, every fixture and vector |
| | clash/keep tie order becomes **open-time order** (earlier land wins ties) — still a bias, so R5a is needed anyway |

Estimate: a multi-week ABI version (comparable to the wide-land write path), touching program, ABI, keeper,
herald, verifier, page, sim and all fixtures; CU per host-id derivation +1 account read where the Province is
not already loaded. **The player-visible part of R5 (tie bias) is fully solved by R5a**; R5b buys capacity and
code simplification, not fairness.

Cheaper alternative for the one concrete need (⑰ prize on a wide season): replace the tally bitmap with a
per-province "tallied" marker account `with_seed(pool, "tl" ‖ P ‖ Q)` created by Tally and closed at Finalize
(rent returned). That is a ⑰ program change, keyed by coordinates, with no host-id change at all.

### 4.3 Order of work (after the first devnet season)

1. (any time, off-chain) H3, then H1, then H2 — each its own PR with tests; H1/H2 with a Playwright check.
2. (next `.so`) R5a in one PR behind byte 83: kernel + ABI params/step + wide resolve + verifier + sim + bots,
   LiteSVM G1 re-measure, tamper test (rewrite byte 83 in a recorded CreateSeason → V-check FAIL on exactly the
   equal-troops donors, as verify-pr79 did for byte 82).
3. (only if Q2 = yes) ⑰ tally by coordinate markers, or R5b as its own ABI version with a written migration story.

## 5. Risks and tests

| Risk | Test |
|---|---|
| R5a changes an honest outcome on old seasons | byte 83 = 0 must call the unchanged `lead_host`: equivalence test over random candidate sets and the existing keep vectors (`keep.rs:600-690`); every `PRESETS` entry except the playable ones asserted 0 (R3's test pattern) |
| Mask not a strict total order | property test: for random candidate sets, exactly one winner; permutation-invariant (`lead_host_with` order tests) |
| Centre bias still present | statistical test: 10,000 bells, two equal hosts from ring 2 and ring 20 → each wins 50 % ± 2 % (today: ring 2 100 %) |
| Grinding | mask from the beacon-anchored clash seed only, never from the Province's `LAST_DIGEST` (a player moves that by acting) |
| G1 margin (853 CU) | LiteSVM G1-CQ heavy keep row re-measured; fail the PR if margin < 500 |
| Verifier drift | replay of a recorded season with an equal-troops donor under byte 83 = 1 → PASS; tamper of byte 83 → FAIL on exactly those donors |
| H1 format drift | shared Rust/JS vectors (`cq_formats_vectors_fresh` pattern) incl. a ring-129 record and a gap-only file |
| H2 page regressions | Playwright: rim home at ring ≥ 126 (devnet-wide preset locally) — map opens on the home, chunks only in view, wide land drawn |
| R5b (if ever) | every `split_host_id` caller listed and replaced; a grep gate that the program has no remaining `split_host_id` |

## 6. Questions for r0ze (blocked on r0ze; nothing above is decided by this document)

- **Q1.** Adopt **R5a** (equal-troops keep donor decided by the bell's beacon, not by "nearer (0,0) wins") as a
  rule change for the **season after the first devnet season** (conquest byte 83, on in the playable presets;
  ruleset hashes unchanged; a new `.so` approval)? Recommended: yes.
- **Q2.** Should the ⑰ prize ever count land **outside ring 17** (rim, wide land)? Today the owner default is
  ring ≤ 17 (t353u), and the prize program refuses the playable devnet preset (`r_max_ceiling` 128,
  `CeilingPastTally`). If yes → coordinate-keyed tally markers (recommended) or R5b. If no → R5b is never needed.
- **Q3.** May the off-chain parts **H1 (sparse control file) and H2 (chunked map loading)** be built before the
  devnet season (no `.so`/ABI change, normal UI merge gate)? Recommended: H3 + H1 yes; H2 after the first
  devnet play-check.

## 7. Doc ↔ code discrepancies found while writing this

- `frontier-abi/src/world_index/mod.rs:9-13` says "The program, the keeper and the verifier do not reach it… Nothing
  here is reachable from a default build". The devnet build `devnet-playable-sbf` enables
  `expedition-dispatch-experimental` → `wide-world-experimental` → `world-index-experimental`
  (`permutation-frontier/Cargo.toml:104-110,174`), and the keeper has `wide*.rs` modules. Stale doc.
- `rules-r3-r5-design.md` §3.2/§3.3 (and ws14 §5) say the wide land's keys are "centre-free". They are unbounded,
  but their order is ring-from-(0,0) (`world_index/coord.rs:12-18, 259-264`) and the wide keep donor tie uses that
  order (`resolve.rs:1003`). The centre bias exists on wide land too.
- `geometry.rs:146` / `:272` still call (0,0) "the Concord" (already listed as D-rules-r3-r5-4; still open).
- `world_index/coord.rs:5-6` "ring = hex distance from the Concord" (same naming).
- `UNBOUNDED-IDENTIFIERS.md` §1 calls the prize bitmap a ring-17 wall but does not note that the playable/devnet
  presets (`r_max_ceiling` 128) are therefore refused by the prize InitPool; nothing in the devnet runbook says a
  prize pool cannot be opened for the playable season.
