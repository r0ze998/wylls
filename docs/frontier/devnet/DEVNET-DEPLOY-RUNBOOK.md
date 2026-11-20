# Devnet deploy runbook for permutation-frontier (DRAFT, 2026-11-18)

> **Status: not run. Nothing has been deployed, funded, airdropped or read on devnet.** Every step marked
> **[r0ze]** needs r0ze's confirmation at the time it runs (owner rule, 2026-11-18 14:42 JST). This runbook only
> covers getting the program onto devnet, the season setup (§6, `frontier-operator`, tested on a local chain
> only) and the services that would follow (§7, blocked on missing code). It builds on [`../m1/PLAYTEST-RUNBOOK.md`](../m1/PLAYTEST-RUNBOOK.md) and
> [`PUBLIC-TEST-DEVNET.ja.md`](PUBLIC-TEST-DEVNET.ja.md). Where they differ, this page follows the code as of
> `origin/main` 50050623.

> **Refreshed 2026-11-20 against `origin/main` 8fdcdb64 (offline; still nothing deployed, no key, no devnet
> contact).** The owner decided on 2026-11-18 16:03 JST (B7) that the **playable lane** (expedition / wide land /
> conquest, `program_version` 0x4804) goes to devnet **first**, not the S1 release. §1a, §4a and §5a give that
> lane's artefact, cost and commands; the S1 text is kept because the S1 release stays deployable. §7 lists what is
> still missing for a *playable* devnet world.

## 1. What gets deployed

| Program | Deployed? | Why |
|---|---|---|
| `permutation-frontier --features devnet-playable-sbf` (`scripts/build-frontier-devnet-playable-sbf.sh`, `program_version` 0x4804) | **yes, first** (owner decision B7) | The playable lane's devnet build (§1a): marker `PSF_DEVNET_PLAYABLE_BUILD`, no program-id check, deployable only through `scripts/devnet/devnet-playable-profile.json` |
| `permutation-frontier`, plain release build (`scripts/build-frontier.sh`, S1 rules, `program_version` 4) | deployable, **not first** (B7) | The only artefact the build calls `deployable yes`; a separate program with its own id and profile (`devnet-profile.json`) |
| `permutation-frontier --features localnet-land-sbf` (what `scripts/play-local.sh` runs) | no | Carries the `PSF_LOCALNET_*` markers (and the TEST-only `PSF_LOCALNET_WIDE_DEPART_BUILD`) and runs only under program id `[0x45; 32]`. Both profiles refuse it (exit 3) |
| `permutation-prize` | no (default); plan only with `--with-prize` | ⑰ reopened 2026-11-18 by the owner, devnet/test-USDC only; a mainnet real-money prize needs a legal review first. `dry-run.mjs --with-prize` checks the `--features epochs` build (`permutation-prize/target/deploy-epochs/permutation_prize.so`, marker `PRZ_EPOCHS_TEST_USDC_BUILD`) and adds its cost; it is never sent (no prize deploy step) |
| `wylls_resident_program` (NFT spike) | no | Not part of any devnet plan. ⑳ was reopened on 2026-11-18 18:26 JST as a devnet/local dry run only: `dry-run.mjs --nft-resident` plans the `nft-experimental` build and its send gate stays closed |
| `permutation-chain` (v9) | no | Superseded by `permutation-frontier` |

The release build measured on 2026-11-18 (this branch, solana-cargo-build-sbf 3.1.9, platform-tools v1.52):

| | value |
|---|---|
| `so_len` | 1,409,560 B |
| `--max-len` (round_up(1.25 × so, 4 KiB)) | 1,765,376 B |
| ProgramData length | 1,765,421 B |
| `file_sha256` | `4483c8424a4a348f6f82789991aae225844084ff626403d4bfffde7cf9b5776b` |
| `program_hash` (trailing zeros stripped) | `f8833dd94c705d6d5fa87224a406ccbffc048b06800005638e2cc604797739d8` |

Another toolchain or another commit can give another hash. Before approving, run the build again and approve the
hash it prints. (An independent rebuild on 2026-11-18 from a fresh checkout gave the same two hashes.)

### 1a. The playable lane's build (B7; measured 2026-11-20 on `origin/main` 8fdcdb64)

`scripts/build-frontier-devnet-playable-sbf.sh --twice` (solana-cargo-build-sbf 3.1.9, platform-tools v1.52, offline,
key-free), both builds identical:

| | value |
|---|---|
| `so_len` | 3,657,488 B |
| `--max-len` | 4,575,232 B |
| ProgramData length | 4,575,277 B |
| `file_sha256` (the value for `--approved-sha256`) | `da3dc1aae66d262ba79321ca9031b4b3510acc13b690154f02b2e304b38b9741` |
| `program_hash` | `786ef80f132a9d2d18afc5708336a396afba32ff3d4c37ebf6c94425a51352df` |

These are the bytes of `frontier-node/fixtures/verify/devnet-playable-da3dc1aa.so.gz` (the `.so` the verifier
tests replay). The hash is unchanged since PR #70; it changes with any edit the build links, so build again right
before approving. The build differs from the local-play lane (`localnet-land-sbf`) by cargo features of
`permutation-frontier` only: it has `devnet-playable-sbf` and lacks `localnet-expedition-sbf`,
`localnet-conquest-sbf`, `localnet-land-sbf` and the TEST-only `localnet-wide-depart` (every dependency resolves
the same features). In code that is the `[0x45; 32]` program-id check, the markers and WideDepart's debit gate
(`proc::wide::DEPART_DEBIT_ENABLED`, closed here: wide → wide marches answer `NotImplemented`). `lib.rs` refuses to
compile `devnet-playable-sbf` together with a localnet lane, `localnet-wide-depart`, `nft-experimental` or any
test feature (oracle, test-beacon, trace, native-crypto-tests, public-proof-tests, runtime-contract-tests), and the build script and the
profile both refuse every other marker.

**Two tool versions are needed** (checked against agave source, 2026-11-18):

| Step | Tool | Why |
|---|---|---|
| Build | `cargo-build-sbf` **3.1.9** (`scripts/build-frontier.sh` refuses any other) | The pinned, reproducible toolchain |
| Deploy, show, dump | `solana` CLI **4.0.0 or newer** | `solana program deploy` first verifies the ELF locally with the CLI's own syscall table. agave v3.1.9 does not register `sol_curve_decompress` or `sol_curve_pairing_map` (`syscalls/src/lib.rs`), which the program calls for BLS12-381 (`permutation-frontier/src/crypto/sys.rs`), so the 3.1.9 CLI stops with `ELF error` before it sends anything. `--skip-feature-verify` does not help there. v4.0.0 to v4.4.1 register both, but only when the cluster's `enable_bls12_381_syscall` feature is active: the CLI reads the cluster's feature set before it checks the ELF (`cli/src/program.rs` `fetch_feature_set`; `syscalls/src/lib.rs` `register_feature_gated_function!`). See §3. [from source; not run] |

The machine here has only 3.1.9 installed. For the read-only checks of §3 a 4.4.1 release was unpacked in isolation
on 2026-11-18 (`solana-release-aarch64-apple-darwin.tar.bz2` of agave v4.4.1, sha256 `e60d6646…8db369`, equal to the
digest GitHub publishes for the asset) and called by its full path; the installed 3.1.9 was not touched. Installing a
4.x CLI for the deploy itself is **[r0ze]**. Keep `active_release` on 3.1.9 (the build script
puts it first on `PATH` itself) and unpack the 4.x release somewhere else, e.g. `~/solana-4x/bin`. Put that
directory first on `PATH` only for §3 and §5. The dry run reads `solana --version` and refuses anything older than
4.0.0.

## 2. Keys (r0ze only; never in the repository, never on a shared machine)

| Key | Role | Where it lives |
|---|---|---|
| **Fee payer / deployer** | Pays the buffer, ProgramData and fees | A file on r0ze's machine, mode 600. Can be emptied and thrown away after the deploy |
| **Program keypair** | Its public key is the program id. Signs only the first deploy | Same. After the deploy it has no power (upgrades need the authority, not this key), but keep it: it proves the address |
| **Upgrade authority** | Upgrades the program, **and is the only key that can sign `AnnounceSeason`** (I-51, `proc/season.rs:118`) | A key **file** on r0ze's machine while the deploy runs, offline (an encrypted file) the rest of the time. Never on the herald, relay or keeper host |

**The upgrade authority is not offline during the deploy.** `solana program deploy --upgrade-authority FILE` makes
that key the buffer's authority, and the buffer authority signs **every** Write transaction (about 1,650 of them) and
the final deploy (agave v3.1.9 `cli/src/program.rs`, `do_process_program_deploy`). So the file must be on the
deploying machine for those minutes, and a hardware wallet is not practical for this command. If the authority must
never touch an online machine, the other route is to deploy with a throwaway authority and hand over afterwards with
`solana program set-upgrade-authority <PROGRAM_ID> --upgrade-authority throwaway.json --new-upgrade-authority
<address> --skip-new-upgrade-authority-signer-check`. The dry run does not script that route, and a wrong address
there is permanent. For devnet, the file route is enough.

**Never deploy with `--final`.** An immutable program has no upgrade authority, so `AnnounceSeason` could never be
signed and no season could ever start. A multisig (e.g. Squads) as the authority is possible later. Every
`AnnounceSeason` would then be a multisig transaction, and the operator tool (`frontier-operator`, §6) signs from a
key file only. For devnet, one offline key is enough.

```sh
# [r0ze] on r0ze's own machine, outside the repository
mkdir -m 700 -p ~/wylls-devnet-keys && cd ~/wylls-devnet-keys
solana-keygen new --outfile deployer.json
solana-keygen new --outfile program.json
solana-keygen new --outfile authority.json
chmod 600 deployer.json program.json authority.json
solana address -k program.json     # → put in scripts/devnet/devnet-profile.json "programId"
solana address -k authority.json   # → "upgradeAuthority"
```

## 3. Read-only checks on devnet first **[r0ze]**

These need nothing but the public RPC, and they decide whether the deploy can work at all.

```sh
# BLS12-381 syscalls (SIMD-0388): PostAnchor, PostSeed, ConsumeGenesisSeed and ConsumeRingSeed need them.
# The agave feature id (master feature-set/src/lib.rs enable_bls12_381_syscall; v3.1.9 does not have it):
solana feature status b1sgUiJ3qu7hYm3tNDyyqZNQd6gLGJmJppnLNa93PCQ --url devnet   # needs the 4.x CLI
# With any CLI version: the feature account exists and its data starts with 01 when the feature is active.
solana account b1sgUiJ3qu7hYm3tNDyyqZNQd6gLGJmJppnLNa93PCQ --url devnet
# SBPF v2 programs may be deployed (enable_sbpf_v2_deployment_and_execution; the .so is e_flags 2):
solana feature status F6UVKh1ujTEFK3en2SyAL3cdVnqko1FVEXWhmdLRu6WP --url devnet
# The rent rate (SIMD-0437 changes it in steps: 6,960 → 6,333 → 5,080 → 2,575 → 1,322 → 696 lamports per byte)
solana rent 1765421 --url devnet   # the ProgramData; divide the answer by (128 + 1,765,421) for the rate
solana rent 0 --url devnet
```

**Measured on 2026-11-18 20:40 JST** (slot 523,617,783, epoch 1212; `solana-cli 4.4.1`, read-only, no key; the
commands and full outputs are in the run's evidence, summarised in `scripts/devnet/devnet-profile.json` `measured`):

| Check | Result |
|---|---|
| BLS12-381 syscalls `b1sg…PCQ` (SIMD-0388) | **active** since epoch 1059, activation slot 457,488,000 |
| SBPF v2 `F6UV…u6WP` (SIMD-0173/0174) | **active** since epoch 918, activation slot 396,576,000 |
| Rent | **5,080 lamports per byte**: `solana rent 1765421` = 8.96898892 SOL = (128 + 1,765,421) × 5,080; `solana rent 0` = 650,240 lamports = 128 × 5,080 |
| Rent feature gates | SIMD-0437-1 (6,333) active since epoch 1137, SIMD-0437-2 (5,080) active since epoch 1141; SIMD-0437-3/4/5 (2,575, 1,322, 696) and SIMD-0438 (reset to 6,960) inactive |
| `solana genesis-hash` | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| `solana cluster-version` | `4.5.0-beta.0` (96 % of stake) |

Two more features matter for a later deploy. **SIMD-0500** (`B8JJ…o83g`, "Disable deployment of SBPF v0, v1 and v2
programs") is **inactive** today; the `.so` is SBPF v2, so once that feature is active a deploy or an upgrade of it
would be refused, and the build would have to move to SBPF v3 (active on devnet since epoch 1069). "Apply a minimum
loaded data size to loader-v3 ProgramData accounts" (`8whk…cWg1`) is active since epoch 1202; its effect on the
`L(kind)` loaded-data limits was not checked. These are one moment's readings: run the checks again right before a
deploy.

Do **not** run `solana feature status b1sg…` with the 3.1.9 CLI: it looks the id up in its own table and panics on
one it does not know (agave v3.1.9 `cli/src/feature.rs:939`, `FEATURE_NAMES.get(feature_id).unwrap()`).

If the BLS feature or the SBPF v2 feature is **not active**, stop. Without SBPF v2 the deploy is refused. Without
the BLS feature the 4.x CLI (v4.0.0 to v4.4.1) stops with `ELF error` before it sends anything, because it registers
`sol_curve_decompress` and `sol_curve_pairing_map` only when `enable_bls12_381_syscall` is active on the cluster it
reads. **Do not pass `--skip-feature-verify` to get past that.** It makes the CLI assume every feature is active,
but validators on those versions apply the same gate when the deploy instruction verifies the ELF. The Writes would
be paid for, the deploy would fail, and a funded buffer would be left to close (§5). agave master registers the two
names unconditionally and checks the feature when the syscall runs; no release up to v4.4.1 does [from source; not
run].

## 4. Cost and funding

Rent-exempt minimum: `(128 + data_len) × lamports_per_byte`. This reproduces the code's own figures at 5,080:
Citizen + Holding = 9,753,600 lamports (DESIGN.md), Province = 24,709,120 (presets.rs).

| lamports/byte | ProgramData | Program | Fees | **Peak the payer needs** | Stays locked |
|---|---|---|---|---|---|
| **5,080 (devnet, measured 2026-11-18)** | 8.9689 | 0.0008 | 0.0166 | **8.99 SOL** | 8.97 SOL |
| 6,960 (the old rate; devnet would return to it only if SIMD-0438 activates) | 12.2882 | 0.0011 | 0.0166 | **12.31 SOL** | 12.29 SOL |

For comparison, the local-play lane's `.so` (3,587,576 B, `max_len` 4,485,120; **not deployable**, §1) would need
22.7853 + 0.0008 + 0.0422 = **22.83 SOL** at its peak at 5,080 (`solana rent 4485165` = 22.78528844 SOL, measured),
and an upgrade float of 18.23 SOL.

**A first deploy does not need "about 2×".** The CLI creates the buffer (37 + `so_len` bytes) but pays into it the
rent of the final ProgramData (45 + `max_len` bytes). The deploy instruction then returns the buffer's lamports to the
payer **before** the payer pays for the ProgramData (agave v3.1.9 `cli/src/program.rs` `do_process_program_deploy`;
`programs/bpf_loader/src/lib.rs`, "Drain the Buffer account to payer before paying for programdata account"). So the
peak is ProgramData + Program + fees. Fees: about 1,660 Write transactions with two signatures each (fee payer and
authority) at 5,000 lamports.

A later **upgrade** holds a second sum for a while: a buffer funded with `rent(45 + so_len)`, 9.81 SOL at 6,960 (7.16
at 5,080), returned when the upgrade lands.

`node scripts/devnet/dry-run.mjs [--rate N]` prints this for the `.so` on disk, and per-season costs too. The devnet
faucet gives at most 5 SOL per request and is rate-limited (solana.com docs), so an S1 deploy alone takes 3 requests at
6,960 (2 at 5,080).

### 4a. The playable lane (B7)

`node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json [--rate N]`, for the §1a
`.so` (4,303 Write transactions, 8,611 signatures):

| lamports/byte | ProgramData | Program | Fees | **Peak the payer needs** | Stays locked | Later upgrade float | One season `S1_DEVNET_WIDE_7D`, 50 players | **Deploy + one season** |
|---|---|---|---|---|---|---|---|---|
| **5,080 (measured 2026-11-18)** | 23.2430 | 0.0008 | 0.0430 | **23.29 SOL** | 23.24 SOL | 18.58 SOL | 98.22 SOL | **121.50 SOL** |
| 6,960 (worst case, SIMD-0438) | 31.8448 | 0.0011 | 0.0430 | **31.89 SOL** | 31.85 SOL | 25.46 SOL | 106.24 SOL | **138.13 SOL** |

At 5 SOL per faucet request: 5 requests for the deploy at 5,080 (7 at 6,960), 25 for deploy + one season (28). Of a
season's 98.22 SOL only 0.625 SOL (fees and tips) is spent; the rest is returned or float. A world that never ends
adds 1.02 SOL per day of AnchorArchives (1.40 at 6,960) [model].

## 5. Deploy **[r0ze]**

```sh
node scripts/devnet/dry-run.mjs --build --twice                       # note file_sha256 (cargo-build-sbf 3.1.9)
export PATH="$HOME/solana-4x/bin:$PATH"                               # the 4.x CLI for the deploy (§1)
node scripts/devnet/dry-run.mjs \
  --i-have-r0ze-approval \
  --keypair ~/wylls-devnet-keys/deployer.json \
  --program-keypair ~/wylls-devnet-keys/program.json \
  --upgrade-authority ~/wylls-devnet-keys/authority.json \
  --approved-sha256 <file_sha256 from the line above>
```

### 5a. The playable lane (B7): the same steps with its own profile and program keypair

```sh
scripts/build-frontier-devnet-playable-sbf.sh --twice                 # note file_sha256 (§1a)
export PATH="$HOME/solana-4x/bin:$PATH"
node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json \
  --i-have-r0ze-approval \
  --keypair ~/wylls-devnet-keys/deployer.json \
  --program-keypair ~/wylls-devnet-keys/program-playable.json \
  --upgrade-authority ~/wylls-devnet-keys/authority.json \
  --approved-sha256 <file_sha256 from the first line>
```

`program-playable.json` is a second program keypair, made like `program.json` in §2 (the playable lane is its own
program, with its own address). Its address and the authority's go into `programId` and `upgradeAuthority` of
`scripts/devnet/devnet-playable-profile.json` (not `devnet-profile.json`).
The deploy command is the one below with `permutation-frontier/target/deploy-devnet-playable-sbf/permutation_frontier.so`
and `--max-len 4575232`; the authority signs about 4,300 Writes. The L(kind) cap of 1,441,792 B below is the S1
profile's; the playable profile's cap is 8,388,608 B.

The script runs these and stops at the first failure: `solana --version` (4.0.0 or newer), `solana address` on both
key files (they must match the profile), `solana balance`, then this deploy command:

```sh
solana program deploy permutation-frontier/target/deploy/permutation_frontier.so --url https://api.devnet.solana.com \
  --keypair deployer.json --fee-payer deployer.json --program-id program.json --upgrade-authority authority.json \
  --max-len 1765376 --use-rpc --commitment confirmed
```

Then `solana program show <PROGRAM_ID>`, and `solana program dump <PROGRAM_ID> <tmp>`. The dumped bytes, with
trailing zeros stripped, must hash to `program_hash`.

**If a deploy fails half-way**, the buffer keeps its SOL. `solana program deploy` makes the upgrade authority the
buffer's authority too (agave v3.1.9 `cli/src/program.rs`, `process_program_deploy`), so closing it needs
`authority.json`:

```sh
solana program show --buffers --buffer-authority "$(solana address -k authority.json)" --url devnet
solana program close --buffers --authority authority.json --recipient "$(solana address -k deployer.json)" --url devnet
```

**Upgrading** (between seasons, or mid-season only if `PROGRAM_VERSION` and every layout stay the same:
PLAYTEST-RUNBOOK §6):

```sh
solana program deploy <new .so> --program-id <PROGRAM_ID address> --upgrade-authority authority.json --keypair deployer.json --url devnet --use-rpc
```

A larger `.so` than `--max-len` needs the ProgramData extended first. `solana program deploy` does that by itself
unless `--no-auto-extend` is given; `solana program extend <PROGRAM_ID> <bytes>` is the manual form [not checked
beyond its arguments]. The L(kind) loaded-data table is computed for a `.so` of at most 1,441,792 B
(`PLACEHOLDER_SO_LEN_S1`), and the dry run refuses anything larger. Today's build leaves 32,232 B of headroom.

**Ending the test:** `solana program close <PROGRAM_ID> --authority authority.json --recipient <address>
--bypass-warning --url devnet` returns the ProgramData rent. Without `--bypass-warning` the CLI only prints its
warning and closes nothing. The program id can then never be used again.

## 6. Season setup with `frontier-operator` **[r0ze, only after r0ze has confirmed the deploy in §5]**

`frontier-operator` (bin of `frontier-node/crates/stack`) sends the operator's part of the start order: AnnounceSeason,
then after the 24-hour lead CreateSeason, InitBeaconLogs and InitShards × 6. These are the same steps, built by the
same code (`stack/src/setup.rs` `announce_step` / `after_announce_steps`), that `frontier-stack up` sends to a local
node. It has only been run against an in-process `frontier-localnet` on loopback, with the release `.so` and test keys
(`frontier-node/crates/stack/tests/operator.rs`). **It has never been run against devnet.**

It reads `scripts/devnet/devnet-profile.json`: `rpcUrl`, `allowedRpcHosts`, `refusedRpcHostPatterns`, `programId`,
`upgradeAuthority`, `rent.assume`, `season.preset` and the `operator` block (`seasonId`, `beacon`). Fill in
`programId` and `upgradeAuthority` after the deploy. The tool refuses:

- a URL that is not loopback and not `https` on an `allowedRpcHosts` host. Hosts containing `mainnet` or `testnet` are
  refused whatever the profile says. `--cluster-url` overrides `rpcUrl` under the same rule;
- a cluster whose `getGenesisHash` (the first call it makes) is mainnet-beta's or testnet's, or for a public URL is not
  devnet's (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`);
- a key file that is a symlink, not owned by you, or readable by group/other (anything but mode 600 or stricter). It
  never prints the key;
- a key whose address is not the profile's `upgradeAuthority`, or not the program's upgrade authority on chain (I-51);
- an announced season with another `params_hash` or authority, a season past setup, or a missed 7-day CreateSeason
  window (the season id is then used up: pick a new `seasonId`);
- sending without `--yes-send`, and sending when the authority's balance is below the plan's total.

```sh
cd frontier-node && cargo build --locked --release -p stack --bin frontier-operator
B=frontier-node/target/release/frontier-operator; P=scripts/devnet/devnet-profile.json; K=~/wylls-devnet-keys/authority.json

$B --profile $P --offline                 # the plan at rent.assume, no RPC (works before the deploy too, once the
                                          # profile has programId and upgradeAuthority)
$B --profile $P --authority $K            # dry run: reads devnet, prints what is missing, the cluster's rent, balance
$B --profile $P --authority $K --yes-send # sends AnnounceSeason, then exits 3: "CreateSeason opens at chain clock T"
# ... 24 h 5 min later (or add --wait to the line above and leave it running):
$B --profile $P --authority $K --yes-send # sends CreateSeason, InitBeaconLogs, InitShards(0..5); exit 0
```

Every run reads the chain first and plans only what is missing, so it can be run again at any time: after the lead,
after a failure half-way (a transaction that did not land is simply planned again), or to check (`setup complete:
nothing to send`). `--max-txs N` stops after N transactions. Exit codes: 0 done (or plan printed), 1 failed, 2
refused, 3 waiting for `t_create_min`.

**What it costs** at the preset `S1_LOCAL_7D`, 6,960 lamports per byte (the plan prints the cluster's own rate when
online): 9 transactions, rent 0.1385 SOL, floats 42 SOL (bond 1, ProvinceFunds 6 × 3.5, DefencePool 20), fees
0.000045 SOL: **42.1385 SOL** from the authority. The bond comes back after a normal season; the floats are the
season's funds (the same lines as the dry run's season cost). The local test checks that the lamports spent equal the dry run's
total.

Then keeper A's `beacon` role sends ConsumeGenesisSeed (PLAYTEST-RUNBOOK §3 step 9), which needs §7.

**The playable lane's season (owner decision B7) is `S1_DEVNET_WIDE_7D`, not `S1_LOCAL_7D`** (devnet-preset-wide).
The wide land starts at ring 129 and needs the legacy ring 128 seeded; `S1_LOCAL_7D`'s map ends at ring 16 (`r_max`
16, no `r_max_ceiling`), so in such a season no wide instruction but WideSetRules could ever land. `S1_DEVNET_WIDE_7D`
is `S1_LOCAL_7D` with four changes: `r_max_ceiling` 128 (ExtendFrontier grows the map one ring per bell, about 21 h
from the genesis ring 3 to the rim), θ 1 bp early and late (a ring needs one settler in some wedge, not 55–65 % of
its sites), `pfund_initial` 36 SOL (every wedge fund must hold `128 × rent(4,736)` at the rim and
`129 × rent(4,864)` for ring 129 above its own rent: 3.16 / 3.27 SOL at 5,080 lamports per byte, 4.33 / 4.48 SOL at
6,960), and (owner decision Q-W1, 2026-11-20) `outpost_tier_min` 0, so a first village on the rim anchors a wide claim
while it is still a Hamlet, as in local wide play. Keeper A's rings duty runs with `extend = true`, `extend_max_ring = 128` and `lazy_provinces = true`: the
genesis rings are opened whole and every later ring without its provinces, which open on demand (opening all 49,537
provinces to ring 128 would cost 1,224 SOL). **Rim first villages (Q-W1):** once ring 128 is opened and seeded, the
same duty's `rim_per_wedge = 6` opens the 42 ring-128 provinces beside the middle six ring-129 provinces of each wedge
(`keeper::rings::rim_plan`, the local wide world's rim; 1.04 SOL of province rent at 5,080, 1.42 SOL at 6,960, out of
the wedge funds' float, not new money). A player's first village there is a one-site **FileTicket** (PlaceHome cannot
name a province past the base `r_max` 16); keeper A's **`tickets`** role settles it on the bell's seed, which its
`beacon` role posts. **The wide land (gaps P6, P7, closed in code):** with `wide_rings = 3` and `wide_per_wedge = 6`
the same duty then opens the wide rings 129, 130 and 131, one a bell after the previous one opened (the program's
rule): WideRequestRingSeed (a 192-byte record, 1,625,600 lamports of rent at 5,080 from keeper A's payer),
WideConsumeRingSeed on the quicknet round the request bound, and WideOpenProvince for the middle six provinces of each
wedge's arc (`keeper::rings::wide_plan`, the local wide world's plan; 108 provinces, 2.74 SOL of rent at 5,080, 3.75
SOL at 6,960, out of the wedge funds' float). Keeper A's **`wide-tickets`** role settles every wide claim on its
bell's seed (WideSettleTicket 0xDC) and finalizes the village when the program's finality rule holds (WideFinalize
0xDF); it pays fees only. Both need keeper A built with `--features playable-lane`. None of this needs a program
change: the `.so` and its sha256 are unchanged. One 50-player season of this preset is **98.22 SOL** at 5,080 (106.24
at 6,960), 15 SOL more float than `S1_LOCAL_7D`. `frontier-operator --preset S1_DEVNET_WIDE_7D` creates this
season (§6b).

### 6b. The playable lane's season: `frontier-operator --preset S1_DEVNET_WIDE_7D` **[r0ze, only after §5a]**

Built with the stack crate's `playable-lane` feature (the wide-land ABI tables). It reads
`scripts/devnet/devnet-playable-profile.json` (its `operator` block: `seasonId` 1, `beacon` quicknet;
`program.programVersion` 0x4804; `program.requiredMarkers` / `refusedMarkers`) and sends, signed by the upgrade
authority's key file only:

| # | Transaction | When | Creates | Lamports from the authority at 5,080 / 6,960 per byte | CU (local) |
|---|---|---|---|---|---|
| 1 | AnnounceSeason (0x08) | now | Season 2,048 B + 1 SOL bond | 1,011,059,080 / 1,015,149,960 | 17,279 |
| 2 | CreateSeason (0x01), the preset's 352 B at version 0x4804 | after the 24 h lead | Frontier, 6 ProvinceFunds (6 SOL float each), DefencePool (20 SOL float) | 56,013,009,800 / 56,017,822,600 | 45,372 |
| 3 | InitBeaconLogs (0x09) | after CreateSeason | 16 BeaconLogs | 20,812,680 / 28,513,160 | 75,363 |
| 4–9 | InitShards(0..5) (0x02) | after CreateSeason | 8 JoinShards each | 15,610,760 / 21,386,120 each | 39,720 each |
| 10 | WideSetRules (0xDB): keep_holder MixedInterleaved, free_city DeployedLe32V1, camp NoCamp, region SortKeyHashV1 (the bytes every lane world and test uses; write-once) | once keeper A's ConsumeGenesisSeed has seeded the season | WideRulesConfig 96 B | 1,142,920 / 1,564,040 | 8,209 |
| | **Total** | | | **57,139,689,040 / 57,191,366,480** (57 SOL float + 0.1396 / 0.1913 SOL rent + 0.00005 SOL fees) | |

Every transaction requests cu_limit 1,400,000 and the runtime's 64 MiB loaded-data limit (the lane's ProgramData
alone is 4.58 MB). Fees are 5,000 lamports each (no priority fee). The CU column is measured on the devnet `.so` in
the local test below. The 57 SOL are floats: the 1 SOL bond comes back after a normal season, and the funds are
the season's own (the same lines as §4a's season cost, whose other 41 SOL are keeper and relay pools, the keeper's
AnchorArchives / BellAnchors and player rent).

```sh
(cd frontier-node && cargo build --locked --release -p stack --features playable-lane --bin frontier-operator)
B=frontier-node/target/release/frontier-operator
P=scripts/devnet/devnet-playable-profile.json            # programId and upgradeAuthority filled after §5a
K=~/wylls-devnet-keys/upgrade-authority.json              # mode 600, outside the repository
H=<the sha256 r0ze approved in §5a, today da3dc1aae66d262ba79321ca9031b4b3510acc13b690154f02b2e304b38b9741>

$B --profile $P --offline        # the plan at rent.assume, no RPC
$B --profile $P --authority $K   # dry run on devnet: the cluster's rent, the balance, the deployed program's sha256
                                 # and markers, "SEND GATE: OPEN/CLOSED"; sends nothing
$B --profile $P --authority $K --yes-send --i-have-r0ze-approval --approved-sha256 $H --record ~/wylls-season-1.jsonl
#   → AnnounceSeason; exit 3 "CreateSeason opens at chain clock T"
# 24 h 5 min later, the same command:
#   → CreateSeason, InitBeaconLogs, InitShards × 6; exit 3 "WideSetRules needs the season Seeded"
# start keeper A (§7; built from this code or later with the wide duties:
#   (cd frontier-node && cargo build --locked --release -p keeper --features playable-lane --bin frontier-keeper)),
# with the profile's roles (beacon, archive, rings, fold, tickets, wide-tickets) and rings duty (extend = true,
# extend_max_ring = 128, lazy_provinces = true, rim_per_wedge = 6, wide_rings = 3, wide_per_wedge = 6); a keeper built
# without the feature refuses `wide_rings` and `wide-tickets`. About 21 min after T it consumes the genesis round.
# Then the same command once more:
#   → WideSetRules; exit 0 "setup complete"; any later run prints "setup complete: nothing to send"
```

On devnet a send needs all three of `--yes-send`, `--i-have-r0ze-approval` and `--approved-sha256`; without them the
tool refuses before it reads the key file or contacts the cluster. A loopback `--rpc` that reaches devnet (an SSH
tunnel, a local proxy) gets the same gate: the cluster's genesis hash decides, so such a send is refused right after
`getGenesisHash`. `--approved-sha256` must equal the sha256 of the
ELF in the deployed ProgramData, and the deployed program must carry `PSF_DEVNET_PLAYABLE_BUILD` and none of the
profile's refused markers. The dry run prints both hashes of the deployed program: the file's `sha256sum`
(`da3dc1aa…`, the one to approve) and `solana-verify get-program-hash`'s (trailing zero bytes stripped: `786ef80f…`,
the `program_hash` of §1a). Everything in §6 holds too (URL and genesis guards, key-file guard, idempotent re-runs,
`--wait`, `--max-txs`). `--t-create-min UNIX` fixes `t_create_min` (≥ the chain clock + 24 h + 60 s); the plan then
prints the genesis round it fixes. `--record FILE` appends one JSON line per landed transaction (signature, slot,
compute units, fee, lamports). `--rpc` is `--cluster-url`; `--preset` overrides the profile's preset.

**Tested offline only** (`frontier-node/crates/stack/tests/operator_playable.rs`, CI key-tests): the committed devnet
`.so` (`frontier-node/fixtures/verify/devnet-playable-da3dc1aa.so.gz`, the §1a artefact) in an in-process
frontier-localnet; this command with `--rpc` on loopback; then the real `frontier-keeper` (`feed = "rpc"`, the
devnet rings duty) with a local `drand-replay` serving the committed real quicknet rounds (the season's
`t_create_min` is chosen so its genesis round is one of them) seeds the season and opens the genesis rings; the
operator's WideSetRules lands; the real `frontier-herald` (`--source rpc --cluster devnet`) folds the season; a test
participant Joins and places a first home in the heartland. Keeper A's ConsumeGenesisSeed took 329,539 CU.

**Rim first village (Q-W1), tested offline too** (the same file, P4; keeper A with the profile's roles and
`rim_per_wedge = 6`). The map's growth to the rim is a **declared patch** (Frontier `rings_opened` 129 / `r_max_ext`
128, RingSeed(128) seeded): the workspace ships 32 quicknet rounds around the genesis, not the 125 bells' rounds. Then,
for real: keeper A opens the 42 rim provinces (OpenProvince 133,174–151,770 CU, fee 26,332 lamports each, rent from
the wedge funds); a test participant Joins (12,752 CU, 2,605,960 lamports) and files a one-site FileTicket at the rim
(12,440 CU, 7,157,640 lamports: fee + the Holding's rent escrow). The ticket bell's anchor and seed are a declared
patch (no shipped round is that bell's T(b)); **keeper A's `tickets` role sends SettleTicket** (21,306 CU) and the
herald shows the rim village. Then: the wide ring 129 by its own instructions bound to a shipped round
(WideRequestRingSeed 15,186 CU and 1,630,600 lamports; WideConsumeRingSeed 330,942 CU; WideOpenProvince 519,987 CU);
the village's own Harvests flip it final and collect a Hamlet's production (about 20 game hours for the slot-2 settler
cost); **WideClaimSite from the rim Hamlet** (25,007 CU, 9,108,360 lamports: fee + the ticket record's rent + escrow);
WideSettleTicket (21,210 CU, its seed again declared) and WideFinalize (6,424 CU), sent by the test. That run
found that the keeper requested the S1 loaded-data limits (1,835,008 B) for this 0x4804 season, so every keeper write
failed `MaxLoadedAccountsDataSizeExceeded`; fixed in `fclient::budgets::canonical_lane`. **It has never been run
against devnet**, and nothing past the genesis rings was reached: rings 4..=128 and the wide land need a live drand
round per bell (§7 P2).

**Keeper A's wide rings and wide claims (gaps P6 + P7), tested offline too** (the same file, P5; keeper A built with
`--features playable-lane`, the profile's roles with `wide-tickets` and its rings duty with `wide_rings = 3`,
`wide_per_wedge = 6`). The run is P4 with **no wide-ring, settle or finalize instruction sent by the test**: keeper A
requests each wide ring's seed as soon as the program allows it (a bell after the previous ring opened), consumes it
on the bound round and opens the ring's 36 planned provinces; its `wide-tickets` role settles the rim Hamlet's wide
claim and finalizes the village. The test only moves the chain's clock so that each request binds one of the 32
shipped quicknet rounds (ring 128 is declared opened in the rim's bell, so the rim's 42 provinces open first; the
claim bell's anchor and seed are declared as in P4). Measured (keeper A's own transactions, the D class's first bid):
WideRequestRingSeed 15,186–15,573 CU (1,625,600 lamports of record rent + the fee), WideConsumeRingSeed
330,628–332,336 CU, WideOpenProvince × 108 476,712–538,387 CU (rent from the wedge funds: 25,359,360 lamports each),
WideSettleTicket 21,410 CU, WideFinalize 6,424 CU. The verifier's VWL judges two witnessed segments, keeper A's
114 wide-ring transactions and the claim → settle → finalize, with **no FAIL and nothing UNVERIFIABLE**. The wide
writes carry their own CU limits (`keeper::widelane::WIDE_BUDGETS`; the canonical budgets tables have no wide rows).

## 7. Services and play (not ready)

Re-checked against the code on 2026-11-20 (`origin/main` 8fdcdb64). G1, G2 and G5 were closed in code by PR #44;
"closed (code)" means tested against loopback only, **never against a real cluster**.

| # | Gap | Status | Evidence |
|---|---|---|---|
| G1 | The Rust services POST JSON-RPC over `https` | closed (code): hardened `curl`, no TLS crate | `frontier-node/crates/fclient/src/https.rs`, `http.rs` `post_json_with` |
| G2 | The keeper reads the program feed from a public RPC | closed (code): `keeper.toml` `feed = "rpc"` (default stays `"localnet"`) | `keeper/src/clusterfeed.rs`, `keeper/src/config.rs` |
| G4 | Operator tool for AnnounceSeason, CreateSeason, InitBeaconLogs, InitShards (and the lane's WideSetRules) | S1 presets: closed (§6). Playable lane: closed (code), `--preset S1_DEVNET_WIDE_7D` (§6b). Both local tests only | `stack/src/operator.rs` |
| K1 | The keeper's transactions fit the lane's program (loaded data) | closed (code): a 0x4804 season takes `Budgets::canonical_lane` (64 MiB); loopback test only | `fclient/src/budgets.rs`, `stack/tests/operator_playable.rs` |
| G5 | Address listing for keeper and relay payers | closed | `frontier-keeper --print-addresses`, `--print-relay-addresses` |
| P1 | **The playable lane's page actions on devnet.** First village, economy and wide claim: closed (code), loopback test only (devnet-page-path). On a devnet season whose gateway runs with `--devnet-play` (cluster devnet, `--rpc` an https URL the operator names, `--devnet-play-ruleset-hash`), the page sends Join, PlaceHome, the rim FileTicket, Harvest, Build, Train, Muster and WideClaimSite itself: the player's connected wallet (`solana:devnet`) signs once and is fee payer AND actor, so it **pays its own fees and rent** (Join 2.61 M, rim FileTicket 7.16 M, wide claim 9.11 M lamports); the gateway's `/f/devnet-play/act/*` rebuilds each command for the transaction's one signer and forwards it once, and sponsors nothing. The Join registers the wallet as its own session key (no in-game key). A wide devnet season (`rMaxCeiling` 128, opened past ring 128) offers opened rim provinces of the player's nation as first villages. The herald must be built with `--features wide-world-experimental,expedition-records-experimental` (as `play-local.sh` builds it): the default build answers `503 WideWorldUnavailable` on `/h/world/wide`, so the page has no wide provinces to claim. Still localnet-only: march, depart, reveal, return and conquest, and the wide village's host acts (WideTrain/WideMuster/WideDepart; P3) | closed (code) for the first village → wide claim; open for marches | `permutation-server/web/frontier/fdevnetplay.mjs`, `flocalplay-act.mjs` `devnetLane`, `permutation-gateway/src/frontier/devnet-play-act.mjs`, `stack/tests/operator_playable.rs` P6 |
| P9 | Who pays a devnet player's fees and rent (O11): the devnet play routes are wallet-paid, so each player needs devnet SOL in their wallet (about 0.02 SOL for Join, rim request and one wide claim, plus fees). A relay-sponsored path (the gateway's pool, as `POST /f/relay` sponsors S1 shapes) is not wired for the lane's wide claim | open, **r0ze** (O11) | `devnet-play-act.mjs` header |
| P2 | First homes at the rim (owner decision Q-W1, 2026-11-20: allowed on wide devnet seasons, as in local play): PlaceHome is capped at the season's base `r_max` 16, so a rim home is a one-site FileTicket, settled by keeper A's `tickets` role, on the rim provinces its `rim_per_wedge` duty opens; `S1_DEVNET_WIDE_7D` has `outpost_tier_min` 0, so that Hamlet anchors a wide claim. The page offers it on a wide devnet season (P1, P6 test) | closed (code), loopback test only | `keeper/src/rings.rs` `rim_plan`, `stack/tests/operator_playable.rs` P4 |
| P3 | Wide → wide marches (WideDepart) answer `NotImplemented` in the devnet build by design (§1a), so a wide keep, which only such a march can reach, cannot be captured there; local TEST only (`localnet-wide-depart`) | closed gate | `proc/wide.rs` `DEPART_DEBIT_ENABLED` |
| P4 | Operator AI residents (`--agent-wallet`, `--agent-runner`) and the test-token faucet are localnet-only | open | `permutation-gateway/src/frontier/config.mjs` |
| P8 | **The keeper's feed guard stops keeper A at the first wide record.** A successful program transaction that logs a `PSW1` record latches the keeper's fail-closed feed guard for good (`keeper/src/feedguard.rs` `bodies`; it survives restarts). From then on only the beacon writes go out (`engine.rs` `allows_write_kind`): rings (with P6's wide rings), fold, tickets and `wide-tickets` stop. On the devnet build a wide village's own actions log one: Economy (Harvest, Build, Train; `proc/wide_economy_exec.rs`), and Muster, Dissolve, Garrison. So the first player who uses a wide village stops keeper A. The offline P5 run never sends one. Recovery today is "an upgraded reader and an operator rebuild" | open (found by devnet-wide-keeper; design question, not changed) | `keeper/src/feedguard.rs`, `keeper/src/landindex.rs` `ingest_page` |
| P5 | Fog of war is a web-client view of LOCAL test worlds only (`LOCAL_FOG` and `cfg.localPlay`); chain data is public | by design | `permutation-server/web/frontier/map/fog.mjs` |

Once they are closed, the order and flags are PLAYTEST-RUNBOOK §3 (steps 7–10) and §4, with `--cluster devnet` for
the herald and `--rpc <provider URL>` for every service. Ports stay in 41000–41999 on the operator host. Only the
herald is public, behind a TLS reverse proxy.
