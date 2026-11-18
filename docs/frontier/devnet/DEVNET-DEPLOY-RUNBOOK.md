# Devnet deploy runbook for permutation-frontier (DRAFT, 2026-11-18)

> **Status: not run. Nothing has been deployed, funded, airdropped or read on devnet.** Every step marked
> **[r0ze]** needs r0ze's confirmation at the time it runs (owner rule, 2026-11-18 14:42 JST). This runbook only
> covers getting the program onto devnet, the season setup (§6, `frontier-operator`, tested on a local chain
> only) and the services that would follow (§7, blocked on missing code). It builds on [`../m1/PLAYTEST-RUNBOOK.md`](../m1/PLAYTEST-RUNBOOK.md) and
> [`PUBLIC-TEST-DEVNET.ja.md`](PUBLIC-TEST-DEVNET.ja.md). Where they differ, this page follows the code as of
> `origin/main` 50050623.

## 1. What gets deployed

| Program | Deployed? | Why |
|---|---|---|
| `permutation-frontier`, plain release build (`scripts/build-frontier.sh`, S1 rules, `program_version` 4) | **yes** | The only artefact the build calls `deployable yes` |
| `permutation-frontier --features localnet-conquest-sbf` (what local play runs) | no | Carries the `PSF_LOCALNET_*` markers and runs only under program id `[0x45; 32]`. The dry run refuses it (exit 3) |
| `permutation-prize` | no | Owner decision ⑰ = A (no prize) |
| `wylls_resident_program` (NFT spike) | no | Owner decision ⑳ = A (no NFT resident) |
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

**Two tool versions are needed** (checked against agave source, 2026-11-18):

| Step | Tool | Why |
|---|---|---|
| Build | `cargo-build-sbf` **3.1.9** (`scripts/build-frontier.sh` refuses any other) | The pinned, reproducible toolchain |
| Deploy, show, dump | `solana` CLI **4.0.0 or newer** | `solana program deploy` first verifies the ELF locally with the CLI's own syscall table. agave v3.1.9 does not register `sol_curve_decompress` or `sol_curve_pairing_map` (`syscalls/src/lib.rs`), which the program calls for BLS12-381 (`permutation-frontier/src/crypto/sys.rs`), so the 3.1.9 CLI stops with `ELF error` before it sends anything. `--skip-feature-verify` does not help there. v4.0.0 to v4.4.1 register both, but only when the cluster's `enable_bls12_381_syscall` feature is active: the CLI reads the cluster's feature set before it checks the ELF (`cli/src/program.rs` `fetch_feature_set`; `syscalls/src/lib.rs` `register_feature_gated_function!`). See §3. [from source; not run] |

The machine here has only 3.1.9. Installing a 4.x CLI is **[r0ze]**. Keep `active_release` on 3.1.9 (the build script
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
| 6,960 | 12.2882 | 0.0011 | 0.0166 | **12.31 SOL** | 12.29 SOL |
| 5,080 | 8.9689 | 0.0008 | 0.0166 | **8.99 SOL** | 8.97 SOL |

**A first deploy does not need "about 2×".** The CLI creates the buffer (37 + `so_len` bytes) but pays into it the
rent of the final ProgramData (45 + `max_len` bytes). The deploy instruction then returns the buffer's lamports to the
payer **before** the payer pays for the ProgramData (agave v3.1.9 `cli/src/program.rs` `do_process_program_deploy`;
`programs/bpf_loader/src/lib.rs`, "Drain the Buffer account to payer before paying for programdata account"). So the
peak is ProgramData + Program + fees. Fees: about 1,660 Write transactions with two signatures each (fee payer and
authority) at 5,000 lamports.

A later **upgrade** holds a second sum for a while: a buffer funded with `rent(45 + so_len)`, 9.81 SOL at 6,960 (7.16
at 5,080), returned when the upgrade lands.

`node scripts/devnet/dry-run.mjs [--rate N]` prints this for the `.so` on disk, and per-season costs too. The devnet
faucet gives at most 5 SOL per request and is rate-limited (solana.com docs), so a deploy alone takes 3 requests at
6,960 (2 at 5,080).

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

## 7. Services (blocked)

These cannot run against devnet with today's code (re-checked 2026-11-18):

| # | Gap | Evidence |
|---|---|---|
| G1 | The Rust services cannot POST JSON-RPC over `https`. `https://` GETs (live drand) now go through a hardened `curl` | `frontier-node/crates/fclient/src/http.rs:5-18, 83-84` |
| G2 | The keeper reads the program feed through `frontier_feed`, a localnet-only call | `frontier-node/crates/keeper/src/main.rs:213` `RpcPort::localnet`; `fclient/src/rpc.rs:624` |
| G4 | **Addressed (§6, `frontier-operator`; local tests only).** Was: no operator tool for AnnounceSeason, CreateSeason, InitBeaconLogs and InitShards against a public RPC | `frontier-node/crates/stack/src/operator.rs` |
| G5 | No address listing for keeper and relay payers | no `--print-addresses` in the keeper |

Once they are closed, the order and flags are PLAYTEST-RUNBOOK §3 (steps 7–10) and §4, with `--cluster devnet` for
the herald and `--rpc <provider URL>` for every service. Ports stay in 41000–41999 on the operator host. Only the
herald is public, behind a TLS reverse proxy.
