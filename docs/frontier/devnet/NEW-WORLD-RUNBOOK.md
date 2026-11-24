# Devnet: program upgrade + the NEW world (DRAFT, 2026-11-24, devnet-new-world-plan)

Owner decisions this follows (STATE.md): 12:07 U2 postpone the world creation and create it **after** the new rules
(#206 neutral wide land + reach from the nation's land, #209 player territory with the 13:15 numbers) are merged and the
devnet program is upgraded, with **all wide land unowned**; 12:07 U3 no ReleaseDormant; Q-4 the devnet upgrade is
approved (devnet only, **never 01:30–03:30 JST**); player-facing text never says "season" ("season" below is the
on-chain name only). Nothing in this file has been run on devnet. Every send needs r0ze's confirmation (§3).

The commands are the existing runbook's (DEVNET-DEPLOY-RUNBOOK.md §5, §6b, §8) with the new world's profile
`scripts/devnet/devnet-new-world-profile.json`; only what differs is spelled out.

## 0. What changes, at a glance

| Piece | Today (live) | New world |
|---|---|---|
| Program `GGFRJr9d…` | `.so` 67a33c92…06b3 (3,447,064 B), ProgramData max_len 4,308,992 | upgraded in place to the build of merged main with #206 + #209 (sha256 **H**, taken from `--twice` on that commit). At territory-q2 a671926d: eb66d974…2e24, 3,514,376 B — fits max_len, **no extend** |
| Season (on-chain) | 2: Announced 11-24 02:15, never created (`47GBAC71…`) | **3** (`5iDH2fZy6jstCpHRvnVxAKY5xqnS63ohAyayvVNPLBHJ`), preset `S1_DEVNET_TERRITORY`, a new AnnounceSeason + the 24 h lead |
| Preset | `S1_DEVNET_WIDE_CONTINUOUS` (params hash f63f0b36…) | `S1_DEVNET_TERRITORY` = the same with `release_after_secs = u32::MAX` (U3). Another params hash (50edfaaa… at a671926d) → Season 2 can **not** be created with it (CreateSeason compares the hash) |
| WideSetRules | `keep_holder MixedInterleaved(1)`, config v2 | `keep_holder NeutralTerritoryV1(4)`, config v3 (every wide keep unowned, 50 troops; player territory) — from the profile's `wide.keepHolder` |
| frontier-operator | hard-coded MixedInterleaved | reads `wide.keepHolder`; refuses `S1_DEVNET_TERRITORY` / byte 3 / byte 4 until #206/#209 are in its build |
| keeper A | 3be56cba binary, `season = 2` | binary from merged main (#192 back-off + #206/#209), `season = 3`; a territory duty (§6, gap G1) |
| herald | `--season 2 --data herald-2` | `--season 3 --data herald-3`, binary from merged main |
| gateway | not started (waits for season 2's rulesetHash) | `--season 3`, new ruleset hash, page/gateway source = merged main |
| health monitor | season 2 / postponed mode | season 3 PDA, t_create_min from chain, driver/keeper season 3 |

## 1. Before anything: what must be true

1. #206 and #209 merged to main, CI green, independently verified with a play-through (merge rule). Their open owner
   questions answered (t497u). Note the merged commit **M**.
2. Gaps closed or knowingly accepted by r0ze (from devnet-new-world-plan, as of territory-q2 a671926d):
   - **G1 keeper:** the territory cranks (WideTerritorySettle / Decay / Conquer, 0xDC ops 12–14) have builders in
     `keeper::widelane::territory` but **no keeper role sends them**. On devnet only keeper A cranks; without a role,
     upkeep, decay and conquest transfer never happen. Needed before CreateSeason.
   - **G2 page (devnet path):** `devnet-play-act.mjs` `DEVNET_ACT_COMMANDS` has no territory tile claim
     (0xDA op 7 WideClaimTile). Without it a devnet player cannot claim tiles.
   - **G3 herald:** the herald must serve the territory accounts to the page (not checked here).
   - **G4 verifier:** `verify` does not know WideClaimTile or the territory ops yet (UNVERIFIABLE at best; ⑪ is after the
     first playable devnet, so not a creation blocker).
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
2. **keeper A:** binary from M with `--features playable-lane` (#192 back-off; territory duty once G1 lands);
   `keeper.toml`: `season = 3`, everything else as today (payer keys do not depend on the season id: the funded
   funders and `delay_floor = 50000000` stay). Add the territory role to the profile's `services.keeperA.roles` and
   to `preflight-checks.mjs RUNBOOK_KEEPER_ROLES` in the same PR as G1.
3. **herald:** binary from M (`--features land-preview,wide-world-experimental,expedition-records-experimental`),
   `--season 3 --data herald-3` (a new data dir); it answers NoSeasonYet until CreateSeason lands. Switch it after
   step 5 (announce), before T. Page source = M (the herald serves `--web` by path: the src-dir swap of
   devnet-services-update, 0 downtime).
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
