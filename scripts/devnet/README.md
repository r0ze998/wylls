# scripts/devnet: the devnet dry run (DRAFT, 2026-11-18)

**Nothing here has been deployed or sent.** The dry run checks the deployable `permutation-frontier` `.so`, computes
what a devnet deploy and one season cost in SOL, and prints the plan and the exact commands. It sends nothing unless
its gate is open, and only r0ze opens it.

| File | What it is |
|---|---|
| `devnet-profile.json` | Cluster URL, allowed RPC hosts, program-id and upgrade-authority **placeholders**, rent rates, the season cost lines (sizes from `frontier-abi/vectors/v2/layouts.json`), the `operator` block read by `frontier-operator` |
| `plan.mjs` | The cost model, the `.so` checks (ported from `scripts/build-frontier.sh`), the send gate and the command list; no side effects of its own |
| `dry-run.mjs` | The command line: wires the real file system and processes into `plan.mjs` |
| `devnet-playable-profile.json` | The **playable lane**'s profile (owner decision B7: expedition / wide land / conquest + the land preview, version 0x4804): its own program-id placeholder, build `scripts/build-frontier-devnet-playable-sbf.sh`, required marker `PSF_DEVNET_PLAYABLE_BUILD`, cap = the loader's 10 MiB, measured devnet rent 5,080 |
| `test/dry-run.test.mjs` | 29 tests with a fake file system and a fake Solana CLI (CI job `devnet-dry-run`, key-free) |
| `test/playable-profile.test.mjs` | 9 tests of the playable profile (marker drift guard both ways, cap, build wiring, gate) |

```sh
node scripts/devnet/dry-run.mjs                  # check the existing .so, print the plan (rate 5,080 lamports/byte, measured on devnet 2026-11-18)
node scripts/devnet/dry-run.mjs --rate 6960      # the same at the old pre-SIMD-0437 rate
node scripts/devnet/dry-run.mjs --build          # build first (scripts/build-frontier.sh), then plan
node scripts/devnet/dry-run.mjs --build --twice  # reproducible build (two fresh target dirs, same hash)
node scripts/devnet/dry-run.mjs --players 200 --json
```

**The playable lane** (B7) is a second program with its own profile:

```sh
scripts/build-frontier-devnet-playable-sbf.sh --twice                                   # reproducible, key-free
node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json   # plan at 5,080 lamports/byte
node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json --build --twice
```

It is the land lane's code (`localnet-land-sbf`) as cargo feature `devnet-playable-sbf`, without the localnet lane's
`[0x45; 32]` program-id check, so it can run under a real program id. Each profile refuses the other's artefact:
the S1 profile refuses `PSF_DEVNET_PLAYABLE_BUILD`, and the playable profile requires it and refuses both localnet
markers. The build keeps the release profile (opt-level 3). Smaller profiles were measured and push S1 instructions
past the CU limits the clients request (reports/devnet-playable-lane.md).

**`--build` stays key-free.** `cargo-build-sbf` writes `<name>-keypair.json` next to the `.so` when that file is
missing, and never reads it (agave v3.1.9 `platform-tools-sdk/cargo-build-sbf/src/post_processing.rs`:
`if !program_keypair.exists() { write_keypair_file(&Keypair::new(), …) }`). So before building, the dry run writes a
text placeholder (`PLACEHOLDER: not a key…`) there if nothing exists (creating `target/deploy/` on a fresh
checkout). An existing file is never changed. `--twice` builds into two temporary directories, and
`scripts/build-frontier.sh --twice` puts the same kind of placeholder in both and fails (exit 5) if either was
replaced.

**The send gate.** Every one of these must hold, or the dry run prints `SEND GATE: CLOSED` with the reasons and exits
without starting any process:

- `--i-have-r0ze-approval`;
- `--keypair FILE` (fee payer), `--program-keypair FILE` and `--upgrade-authority FILE`. Each must be an absolute
  path to a regular file with mode 600, owned by you and outside the repository. The script never reads these files;
  the Solana CLI does;
- `--approved-sha256 HEX`, equal to the `.so`'s `file_sha256`. The approval is for one artefact;
- `programId` and `upgradeAuthority` filled in the profile with real base58 addresses;
- an `https` RPC URL whose host is in `allowedRpcHosts`. Hosts naming mainnet or testnet are refused by the code
  itself, whatever a `--profile` file allows;
- a `.so` that passes every check.

With the gate open, it runs these steps in order and stops at the first failure:

1. `solana --version`. It must be 4.0.0 or newer: the 3.1.9 CLI cannot verify this program's BLS12-381 syscalls
   (`sol_curve_decompress`, `sol_curve_pairing_map`) and would stop with an ELF error. The build stays on
   `cargo-build-sbf` 3.1.9.
2. `solana address` on both key files. Each address must match the profile.
3. `solana balance`.
4. `solana program deploy … --max-len <round_up(1.25 × .so, 4 KiB)> --use-rpc`.
5. `solana program show`.
6. `solana program dump`. The dumped bytes, with trailing zeros removed, must hash to the `.so`'s `program_hash`.

**Cost.** A first deploy needs ProgramData rent + Program rent + fees at its peak (8.99 SOL at 5,080 lamports per
byte, devnet's rate as read on 2026-11-18, for today's `.so`; 12.31 SOL at the old 6,960), not twice that: the CLI funds the buffer with the ProgramData rent and the deploy returns it
before the ProgramData is paid. A later upgrade holds a returned buffer float (`upgrade(temp)` in the plan).

There is no airdrop, no `--final` (the upgrade authority is the only `AnnounceSeason` signer, I-51, so an immutable
program could never start a season) and no season step. The season setup (AnnounceSeason, CreateSeason,
InitBeaconLogs, InitShards) is a separate tool, `frontier-operator` (`frontier-node/crates/stack`), run **after** r0ze
has confirmed the deploy. It reads this profile (`rpcUrl`, the host lists, `programId`, `upgradeAuthority`,
`rent.assume`, `season.preset` and the `operator` block) and is a dry run unless given `--yes-send`. See the
runbook §6.

The full runbook: [`docs/frontier/devnet/DEVNET-DEPLOY-RUNBOOK.md`](../../docs/frontier/devnet/DEVNET-DEPLOY-RUNBOOK.md).
