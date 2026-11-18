# Devnet deploy runbook for permutation-frontier (DRAFT, 2026-11-18)

> **Status: not run. Nothing has been deployed, funded, airdropped or read on devnet.** Every step marked
> **[r0ze]** needs r0ze's confirmation at the time it runs (owner rule, 2026-11-18 14:42 JST). This runbook only
> covers getting the program onto devnet and the services that would follow. Season creation is blocked on
> missing code (§6). It builds on [`../m1/PLAYTEST-RUNBOOK.md`](../m1/PLAYTEST-RUNBOOK.md) and
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
hash it prints.

## 2. Keys (r0ze only; never in the repository, never on a shared machine)

| Key | Role | Where it lives |
|---|---|---|
| **Fee payer / deployer** | Pays the buffer, ProgramData and fees | A file on r0ze's machine, mode 600. Can be emptied and thrown away after the deploy |
| **Program keypair** | Its public key is the program id. Signs only the first deploy | Same. After the deploy it has no power (upgrades need the authority, not this key), but keep it: it proves the address |
| **Upgrade authority** | Upgrades the program, **and is the only key that can sign `AnnounceSeason`** (I-51, `proc/season.rs:118`) | Offline (hardware wallet or an encrypted file). Never on the herald, relay or keeper host |

**Never deploy with `--final`.** An immutable program has no upgrade authority, so `AnnounceSeason` could never be
signed and no season could ever start. A multisig (e.g. Squads) as the authority is possible later. Every
`AnnounceSeason` would then be a multisig transaction, and the operator tool (G4) does not exist yet. For devnet, one
offline key is enough.

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
# The agave feature id (feature-set/src/lib.rs enable_bls12_381_syscall):
solana feature status b1sgUiJ3qu7hYm3tNDyyqZNQd6gLGJmJppnLNa93PCQ --url devnet
# The rent rate (SIMD-0437 lowers it in steps: 6,960 → 6,333 → 5,080 → 2,575 → 1,322 lamports per byte)
solana rent 1765421 --url devnet   # the ProgramData; divide the answer by (128 + 1,765,421) for the rate
solana rent 0 --url devnet
```

If the BLS feature is **not active**, stop. The program uses those syscalls, and a deploy's ELF check refuses an
unknown syscall, so the deploy would fail after the buffer is written. The buffer's SOL can be recovered (§5), but the
game cannot run.

## 4. Cost and funding

Rent-exempt minimum: `(128 + data_len) × lamports_per_byte`. This reproduces the code's own figures at 5,080:
Citizen + Holding = 9,753,600 lamports (DESIGN.md), Province = 24,709,120 (presets.rs).

| lamports/byte | Buffer (held during the deploy, returned) | ProgramData | Program | Fees | **Peak the payer needs** | Stays locked |
|---|---|---|---|---|---|---|
| 6,960 | 9.8116 | 12.2882 | 0.0011 | 0.0078 | **22.11 SOL** | 12.29 SOL |
| 5,080 | 7.1614 | 8.9689 | 0.0008 | 0.0078 | **16.14 SOL** | 8.97 SOL |

`node scripts/devnet/dry-run.mjs [--rate N]` prints this for the `.so` on disk, and per-season costs too. The devnet
faucet gives at most 5 SOL per request and is rate-limited (solana.com docs), so a deploy alone takes 4–5 requests.

## 5. Deploy **[r0ze]**

```sh
node scripts/devnet/dry-run.mjs --build --twice                       # note file_sha256
node scripts/devnet/dry-run.mjs \
  --i-have-r0ze-approval \
  --keypair ~/wylls-devnet-keys/deployer.json \
  --program-keypair ~/wylls-devnet-keys/program.json \
  --upgrade-authority ~/wylls-devnet-keys/authority.json \
  --approved-sha256 <file_sha256 from the line above>
```

The script runs these and stops at the first failure: `solana --version`, `solana address` on both key files (they
must match the profile), `solana balance`, then this deploy command:

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

A larger `.so` needs `solana program extend <PROGRAM_ID> <bytes>` first (the CLI extends by itself unless
`--no-auto-extend`). The L(kind) loaded-data table is computed for a `.so` of at most 1,441,792 B
(`PLACEHOLDER_SO_LEN_S1`), and the dry run refuses anything larger. Today's build leaves 32,232 B of headroom.

**Ending the test:** `solana program close <PROGRAM_ID> --authority authority.json --recipient <address> --url devnet`
returns the ProgramData rent. The program id can then never be used again.

## 6. Season and services (blocked)

These cannot run against devnet with today's code (re-checked 2026-11-18):

| # | Gap | Evidence |
|---|---|---|
| G1 | The Rust services cannot POST JSON-RPC over `https`. `https://` GETs (live drand) now go through a hardened `curl` | `frontier-node/crates/fclient/src/http.rs:5-18, 83-84` |
| G2 | The keeper reads the program feed through `frontier_feed`, a localnet-only call | `frontier-node/crates/keeper/src/main.rs:213` `RpcPort::localnet`; `fclient/src/rpc.rs:624` |
| G4 | No operator tool for AnnounceSeason, CreateSeason, InitBeaconLogs and InitShards against a public RPC | only `frontier-node/crates/stack/src/setup.rs` |
| G5 | No address listing for keeper and relay payers | no `--print-addresses` in the keeper |

Once they are closed, the order and flags are PLAYTEST-RUNBOOK §3 (steps 7–10) and §4, with `--cluster devnet` for
the herald and `--rpc <provider URL>` for every service. Ports stay in 41000–41999 on the operator host. Only the
herald is public, behind a TLS reverse proxy.
