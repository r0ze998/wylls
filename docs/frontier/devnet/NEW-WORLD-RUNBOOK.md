# Devnet: program upgrade + the NEW world (DRAFT, 2026-11-24, devnet-new-world-plan; territory steps 2026-11-25, devnet-territory-dev)

Owner decisions this follows (STATE.md): 12:07 U2 postpone the world creation and create it **after** the new rules
(#206 neutral wide land + reach from the nation's land, #209 player territory with the 13:15 numbers) are merged and the
devnet program is upgraded, with **all wide land unowned**; 12:07 U3 no ReleaseDormant; Q-4 the devnet upgrade is
approved (devnet only, **never 01:30–03:30 JST**); player-facing text never says "season" ("season" below is the
on-chain name only). Nothing in this file has been run on devnet. Every send needs r0ze's confirmation (§3).

**Later owner decisions (authoritative):** NWP-1 (19:28) world 2 aborted for its bond (done 11-24); NWP-2 create world 3
**only after territory is playable on devnet** (keeper A runs upkeep/decay, the devnet page sends claims) **and r0ze
re-confirms right before the create**; NWP-3 after the upgrade move ≈2 SOL deployer → authority; NWP-4 on-chain id 3;
23:58 item 7: the wallet signing text change (fsession.mjs "World: N", #219) **must be merged before world 3 is
created**. The ordered checklist is §0a.

## 0a. The order, start to finish (devnet-territory-dev)

| Step | What | Who / gate | Notes |
|---|---|---|---|
| 0 | #219 (signing text "World: N") merged; this PR (keeper `territory` role, devnet tile claim) merged; P18 re-run on the merge commit | CI + independent verify | §1 |
| 1 | Build the `.so` on the merge commit M: `scripts/build-frontier-devnet-playable-sbf.sh --twice` → sha256 **H**, so_len | anyone | main ca317418 (this PR does not change the program): **H = 31acbb59757f0c9fe52ca3a6fbda73f76ac957d5be2aef0a8a113843916819e7**, 3,517,472 B, program_hash 3ee8f824…59fd (single build; take H from `--twice` on M) |
| 2 | Read devnet: SIMD-0500 inactive, SIMD-0433 state, deployer and authority balances, rent rate | read-only (B5) | §1.3, §1.4 |
| 3 | Upgrade in place **[R2: "upgrade OK H"]** | r0ze; never 01:30–03:30 JST; devnet only, never `--final` | §4. Peak ≈ (128+37+3,517,472)×5,080 = **17.870 SOL** + ≈0.04 fees, back when it lands; deployer 23.649 SOL (11-24) |
| 4 | Move ≈2 SOL deployer → authority (NWP-3) **[R5]** | r0ze | `solana transfer --from ~/wylls-devnet-keys/deployer.json 7sVNs9v5E3Euv5A2aeZEwmzABwc6zhDHskzqo8jz9CbA 2 --fee-payer ~/wylls-devnet-keys/deployer.json --url https://api.devnet.solana.com --commitment confirmed` (authority 57.628 SOL vs the plan's 57.1397: margin 0.49 → ≈2.49) |
| 5 | Switch herald / gateway / keeper A binaries to M (still no world 3) | R4 | §6; keeper A with role `territory` |
| 6 | Announce world 3 **[R3: params hash P + H]**, between ≈09:00 and 22:00 JST | r0ze | §5; tell players ≥ 24 h ahead (the program's lead: CreateSeason opens at t_create_min = announce + 24 h + 300 s) |
| 7 | **r0ze re-confirms the create** (NWP-2) — with P18's evidence and the live page/keeper status | r0ze | nothing is sent without it |
| 8 | CreateSeason, InitBeaconLogs, InitShards ×6 (driver at T+90), keeper A seeds, WideSetRules NeutralTerritoryV1 | driver / operator | §6.1 |
| 9 | Join check from the page; the first tile claim from the page (preview, then sign); keeper A's `/v1/status` `territory.landed["territory-settle"]` grows every bell | anyone | §6.6 |


The commands are the existing runbook's (DEVNET-DEPLOY-RUNBOOK.md §5, §6b, §8) with the new world's profile
`scripts/devnet/devnet-new-world-profile.json`; only what differs is spelled out.

## 0. What changes, at a glance

| Piece | Today (live) | New world |
|---|---|---|
| Program `GGFRJr9d…` | `.so` 67a33c92…06b3 (3,447,064 B), ProgramData max_len 4,308,992 | upgraded in place to the build of merged main with #206 + #209 (sha256 **H**, taken from `--twice` on that commit). On main ca317418 (devnet-territory-dev, single build): **31acbb59…19e7, 3,517,472 B** — fits max_len (791,520 B spare), **no extend** |
| Season (on-chain) | 2: Announced 11-24 02:15, never created (`47GBAC71…`) | **3** (`5iDH2fZy6jstCpHRvnVxAKY5xqnS63ohAyayvVNPLBHJ`), preset `S1_DEVNET_TERRITORY`, a new AnnounceSeason + the 24 h lead |
| Preset | `S1_DEVNET_WIDE_CONTINUOUS` (params hash f63f0b36…) | `S1_DEVNET_TERRITORY` = the same with `release_after_secs = u32::MAX` (U3). Another params hash (50edfaaa… at a671926d) → Season 2 can **not** be created with it (CreateSeason compares the hash) |
| WideSetRules | `keep_holder MixedInterleaved(1)`, config v2 | `keep_holder NeutralTerritoryV1(4)`, config v3 (every wide keep unowned, 50 troops; player territory) — from the profile's `wide.keepHolder` |
| frontier-operator | hard-coded MixedInterleaved | reads `wide.keepHolder`; refuses `S1_DEVNET_TERRITORY` / byte 3 / byte 4 until #206/#209 are in its build |
| keeper A | 3be56cba binary, `season = 2` | binary from merged main (#192 back-off + #206/#209), `season = 3`, role **`territory`** (devnet-territory-dev: upkeep settle every bell, decay, conquest transfer) |
| herald | `--season 2 --data herald-2` | `--season 3 --data herald-3`, binary from merged main |
| gateway | not started (waits for season 2's rulesetHash) | `--season 3`, new ruleset hash, page/gateway source = merged main; its devnet act list carries **TerritoryClaim** (wallet-paid tile claim; context names the records' rent) |
| health monitor | season 2 / postponed mode | season 3 PDA, t_create_min from chain, driver/keeper season 3 |

## 1. Before anything: what must be true

1. #206 and #209 merged to main, CI green, independently verified with a play-through (merge rule). Their open owner
   questions answered (t497u). Note the merged commit **M**.
2. Gaps closed or knowingly accepted by r0ze (from devnet-new-world-plan, as of territory-q2 a671926d):
   - **G1 keeper — closed in code (devnet-territory-dev, keeper role `territory`, `keeper/src/territory.rs`):** once
     a bell it settles every known Citizen's territory upkeep (0xDC op 12), decays unpaid land past 24 bells, farthest
     first, one a bell (settle alone, then settle + op 13), and moves a captured province's tiles to the captor (settle
     both + op 14; village tiles stay). Players from the JOIN records; provinces from every landed WideClaimTile in the
     feed. #192 refusal back-off applies; `/v1/status` → `territory` counters. Proven offline in operator_playable
     **P18** on the new `.so` (§0a).
   - **G2 page — closed in code:** the gateway's `DEVNET_ACT_COMMANDS` carries `TerritoryClaim`; the page's wide claim
     card on a devnet territory world shows 「1マス取る」 and previews ore + SOL before the wallet signs (P18).
   - **G3 herald — checked in P18:** the page reads a province's territory facts (site tiles, keep tile, the
     territory byte) from the herald's wide route captures; the territory records themselves are read through the
     gateway's territory context (rent, presence, tiles). No herald change was needed.
   - **G4 verifier — still open:** `verify` does not know WideClaimTile or the territory ops yet (UNVERIFIABLE at best;
     ⑪ is after the first playable devnet, so not a creation blocker).
   - **#219** (wallet signing text "World: N") must be merged before world 3 is created — owner 23:58 item 7: merged
     11-25 03:41 JST (6b5409ec).
3. Read devnet's feature state (read-only, 4.x CLI; B5): **SIMD-0500** `B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`
   must be **inactive** (the `.so` is SBPF v2; active = the upgrade is refused: blocker, r0ze). **SIMD-0433**
   `EhisBfVtGvEA8bVCVN5VMaYEaX6iTfoUrmcDi8LY7Kxy` decides whether the upgrade shrinks ProgramData (§4).
   `solana feature status B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g EhisBfVtGvEA8bVCVN5VMaYEaX6iTfoUrmcDi8LY7Kxy --url https://api.devnet.solana.com`
4. Money (getBalance, read-only): deployer ≥ the upgrade peak (§4: ≈17.9 SOL at 3.51 MB and 5,080 lamports/byte;
   23.649 SOL on 11-24); authority ≥ the operator's plan (57.1397 SOL at 5,080 for the 10 transactions incl. the 1 SOL
   bond; 57.628 SOL on 11-24 → margin 0.49 SOL, 1.49 if Season 2's bond is refunded, §2).

## 2. Season 2 (announced, never created) — r0ze decides (inbox Q-NWP-1)

- Season 2 cannot become the new world while U3 is a preset parameter (above). Its 1 SOL bond returns only on an
  authority AbortSeason **before 02:31:06 JST 11-25** (its genesis round time); the owner's 01:30–03:30 rule makes the
  real deadline **01:30 JST 11-25**. After that an abort burns the bond; anyone may abort it from 12-02 02:20:04.
- (a) refund now: `scripts/devnet/abort-season-2.mjs` (same gate as the Season 1 abort that landed 11-24 06:34):
  ```sh
  node scripts/devnet/abort-season-2.mjs                                  # dry run: read + simulate, key-free
  node scripts/devnet/abort-season-2.mjs --key ~/wylls-devnet-keys/authority.json   # dry run + key check
  node scripts/devnet/abort-season-2.mjs --key ~/wylls-devnet-keys/authority.json --yes-send \
    --i-have-r0ze-approval --approved-sha256 67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3
  ```
  It refuses unless Season 2 is exactly the announced account (status 0, t_create_min 1795540804, params f63f0b36…,
  bond 1 SOL) and Season 1 is Aborted, and it refuses from 01:30 JST 11-25 on. Before the upgrade, so the approved sha
  is still 67a33c92. **Needs independent verification before use.**
- (b) keep Season 2 for the new world: only if U3 becomes a program rule instead of a parameter (territory-impl change);
  then the profile keeps `S1_DEVNET_WIDE_CONTINUOUS`, `seasonId 2`, `wide.keepHolder NeutralTerritoryV1`, and the
  operator creates it before 12-02 02:20:04 JST (no new 24 h lead).
- (c) nothing: 1 devnet SOL lost later.

## 3. r0ze's confirmations (each in chat, each for exact values)

| # | What | Exact value r0ze confirms |
|---|---|---|
| R1 | Season 2: abort (a) / keep (b) / nothing (c) | the choice; for (a) the send before 01:30 JST 11-25 |
| R2 | program upgrade | "upgrade OK **H**" (sha256 of the `.so` from `--twice` on M; size ≤ 4,308,992) |
| R3 | AnnounceSeason 3 (1 SOL bond + rent, irreversible id) | params hash **P** from the operator's devnet dry run with the new binary, and the approved sha H |
| R4 | service switch to season 3 (no SOL) | herald/gateway/keeper restart window |
| R5 | funding moves if any (keeper funders, authority top-up) | amounts |

## 4. The upgrade **[r0ze: R2]**

Timing: not 01:30–03:30 JST. Nothing live depends on the program today (Season 2 is only Announced; keeper A and the
gateway are not running; the herald answers NoSeasonYet), so the upgrade itself interrupts no player.

```sh
git checkout M                                            # the merged commit, in a clean checkout
scripts/build-frontier-devnet-playable-sbf.sh --twice     # → file_sha256 = H, so_len (must be ≤ 4,308,992)
B=frontier-node/target/release/frontier-operator
(cd frontier-node && cargo build --locked --release -p stack -p verify \
   --features stack/playable-lane,verify/playable-lane --bin frontier-operator --bin frontier-verify)
$B --profile scripts/devnet/devnet-new-world-profile.json --offline
#   expect: season id 3 5iDH2fZy…  preset S1_DEVNET_TERRITORY; tx 10 WideSetRules config_version 3,
#           keep_holder NeutralTerritoryV1(4); total ≈ 57.14 SOL at 5,080. An operator built before #209 refuses here.
export PATH="$HOME/solana-4x/bin:$PATH"                   # 4.x CLI
solana-keygen new --no-bip39-passphrase -o ~/wylls-devnet-keys/buffer-new-world.json   # [r0ze] resumable, no phrase printed
solana program deploy permutation-frontier/target/deploy-devnet-playable-sbf/permutation_frontier.so \
  --url https://api.devnet.solana.com --keypair ~/wylls-devnet-keys/deployer.json --fee-payer ~/wylls-devnet-keys/deployer.json \
  --program-id GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr --upgrade-authority ~/wylls-devnet-keys/authority.json \
  --buffer ~/wylls-devnet-keys/buffer-new-world.json --with-compute-unit-price 5000 --max-sign-attempts 50 --commitment confirmed
#   no --use-rpc (TPU route, devnet-deploy-2); no --max-len (an upgrade keeps or shrinks ProgramData)
solana program show GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr --url https://api.devnet.solana.com
solana program dump GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr /tmp/after.so --url https://api.devnet.solana.com
$B --profile scripts/devnet/devnet-new-world-profile.json --authority ~/wylls-devnet-keys/authority.json
#   expect "program sha256 H … markers PSF_DEVNET_PLAYABLE_BUILD", "this key is its upgrade authority"
```

Cost (measured on a local agave 4.4.1 validator, 67a33c92 → the territory build, 6,960 lamports/byte; scaled to 5,080):
- **Peak** = the buffer's rent `(128 + 37 + so_len) × rate` + write fees. Locally: 24.4996 SOL drop at 6,960
  (24.4612 rent + 0.0384 fees, 3,839 writes × 2 signatures). At 5,080 and 3,514,376 B: 17.8539 + ≈0.04 ≈ **17.89 SOL**
  (plus the 5,000 µlamport/CU priority fee devnet-deploy-2 used). Returned when the upgrade lands.
- **Net**: SIMD-0433 inactive → ProgramData keeps 4,308,992 B, net ≈ −0.04 SOL. SIMD-0433 active (it is in the
  4.4.1 test validator) → ProgramData is cut to the ELF length (3,514,376) and `(4,308,992 − so_len) × rate`
  (≈ **+4.04 SOL** at 5,080) comes back to the deployer; a later, larger upgrade then needs `solana program extend`
  first (or the CLI's auto-extend).
- The DEVNET-DEPLOY-RUNBOOK's "21.89 SOL at its peak" for an upgrade is the FIRST deploy's ProgramData rent at max_len,
  not an upgrade's peak (D-devnet-new-world-plan-3).
- If it fails half-way: run the same line again (the buffer resumes), or close the buffer (runbook §5).

### Rollback

Same deploy line with the previous `.so` (`gunzip -c frontier-node/fixtures/verify/devnet-playable-67a33c92.so.gz`,
sha256 67a33c92…06b3) and a fresh buffer keypair. Measured locally: 22 s, ProgramData 3,447,064 B, dumped sha
67a33c92. **Safe only before season 3's CreateSeason** (better: before AnnounceSeason 3): once the world has a
v3 RulesConfig or territory accounts, the old program cannot read them; after that, fix forward with a new upgrade.

## 5. AnnounceSeason 3 **[r0ze: R3]**

Timing: the announce and the whole create window `t_create_min … t_create_min + ≈35 min` (CreateSeason, genesis
≈ +21 min, WideSetRules, join check) must avoid 01:30–03:30 JST: announce between about 09:00 and 22:00 JST
(t_create_min = announce + 24 h + 300 s margin).

```sh
P=scripts/devnet/devnet-new-world-profile.json; K=~/wylls-devnet-keys/authority.json
$B --profile $P --authority $K                                       # dry run: P (params hash), balance, gate
$B --profile $P --authority $K --yes-send --i-have-r0ze-approval --approved-sha256 $H --max-txs 1 --record ~/wylls-season-3.jsonl
#   → AnnounceSeason; exit 3 "CreateSeason opens at chain clock T"   (measured on the local validator: 12,779 CU)
```

## 6. Services, in order (the run directory's scripts are r0ze's / the operator run's; never edit a running script)

1. **Driver:** a copy of `season-driver.sh` for season 3 (new file; the old one is not running since 12:09):
   `keeper-a/keeper.toml` check `season = 3`; `CREATE_AT=T` (the chain's t_create_min from step 5, not a guess);
   `H=` the new sha; `OP=` the operator built from M; `--profile …/devnet-new-world-profile.json`; record
   `season-3.jsonl`. It sends at T+90, starts keeper A, re-runs until WideSetRules (exit 0).
2. **keeper A:** binary from M with `--features playable-lane` (#192 back-off; the `territory` role);
   `keeper.toml`: `season = 3`, `roles = [… the runbook's 16 …, "territory"]` (the profile's `services.keeperA.roles`;
   `preflight-checks.mjs keeperRolesFor` requires it for S1_DEVNET_TERRITORY), optional `territory_settle_bells = 1`
   and `territory_per_bell = 24` (the defaults); everything else as today (payer keys do not depend on the season id:
   the funded funders and `delay_floor = 50000000` stay). Watch `/v1/status` → `territory` (`landed`, `refused`,
   `unpaid`, `tiles`).
3. **herald:** binary from M (`--features land-preview,wide-world-experimental,expedition-records-experimental`),
   `--season 3 --data herald-3` (a new data dir); it answers NoSeasonYet until CreateSeason lands. Switch it after
   step 5 (announce), before T. Page source = M (the herald serves `--web` by path: the src-dir swap of
   devnet-services-update, 0 downtime).
   **The page before the create (page-not-open-yet):** while the herald answers `503 NoSeasonYet` — no account for
   its `--season`, or only the announced one — the game page says "The world is not open yet" on its calm banner
   and on the plate (not the red "the world's record cannot be read (HTTP503)" / "check your connection"), keeps
   asking every 30 s and opens the world by itself. The herald does not serve the announced time, so to name it put
   one file beside the page: `<web>/frontier/world-open.json` = `{"v":1,"opensAt":<t_create_min, unix seconds>}`
   (world 3: `{"v":1,"opensAt":1795662000}`). The page then says "It opens on or after <that time in the reader's
   zone>"; without the file, or once the time is past, "It opens soon". The file is not in the repository (it is this
   run directory's own): write it again after a src-dir swap, and remove it after the create (it is not read once a
   world answers). A failed connection is still the red line.
4. **gateway:** `gateway-starter.sh` with `--season 3`; it waits for `/h/season`'s rulesetHash of season 3. Fresh
   `relay/` (season 2's was never created).
5. **health monitor:** season 3 PDA `5iDH2fZy6jstCpHRvnVxAKY5xqnS63ohAyayvVNPLBHJ`, `createAt` = T from chain,
   driver/keeper/herald/gateway season 3; the "postponed" mode (health-postponed-mode run) ends. `node scripts/devnet/preflight.mjs --profile scripts/devnet/devnet-new-world-profile.json`
   checks herald/gateway/keeper `--season` against the profile's `seasonId` 3.
6. **join check:** reads the season from the page; no change.

## 7. Repo follow-ups after the upgrade lands

- `scripts/devnet/devnet-playable-profile.json` → the live profile becomes the new world's (or the new file replaces
  it): `program.requiredMarkers` unchanged; notes with H, slot, season 3.
- 67a33c92 pins that describe "the deployed program": `preflight-checks.mjs`, `fdevnet-wide-village.mjs`,
  `operator.rs` (doc), runbook §1a/§5a/§8; the verifier/stack tests that use the 67a33c92 fixture stay (they test that
  artefact), and a new fixture of H is added for the devnet-path tests.
- `scripts/devnet/health.mjs` DEPLOY block (season, createAt), `docs/frontier/PLAY-DEVNET*.md` times (estimates).
