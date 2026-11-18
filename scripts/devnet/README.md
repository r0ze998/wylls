# scripts/devnet: the devnet dry run (DRAFT, 2026-11-18)

**Nothing here has been deployed or sent.** The dry run checks the deployable `permutation-frontier` `.so`, computes
what a devnet deploy and one season cost in SOL, and prints the plan and the exact commands. It sends nothing unless
its gate is open, and only r0ze opens it.

| File | What it is |
|---|---|
| `devnet-profile.json` | Cluster URL, allowed RPC hosts, program-id and upgrade-authority **placeholders**, rent rates, the season cost lines (sizes from `frontier-abi/vectors/v2/layouts.json`) |
| `plan.mjs` | The cost model, the `.so` checks (ported from `scripts/build-frontier.sh`), the send gate and the command list; no side effects of its own |
| `dry-run.mjs` | The command line: wires the real file system and processes into `plan.mjs` |
| `test/dry-run.test.mjs` | 36 tests with a fake file system and a fake Solana CLI (CI job `devnet-dry-run`, key-free) |

```sh
node scripts/devnet/dry-run.mjs                  # check the existing .so, print the plan (rate 6,960 lamports/byte)
node scripts/devnet/dry-run.mjs --rate 5080      # the same at the SIMD-0437 rate the code's figures use
node scripts/devnet/dry-run.mjs --build          # build first (scripts/build-frontier.sh), then plan
node scripts/devnet/dry-run.mjs --build --twice  # reproducible build (two fresh target dirs, same hash)
node scripts/devnet/dry-run.mjs --players 200 --json
node scripts/devnet/dry-run.mjs --with-prize      # ⑰ (devnet/test USDC only): also check the epochs prize .so and add its cost; never sent
```

**⑰ prize (`--with-prize`).** The owner reopened ⑰ on 2026-11-18, for devnet and test USDC only. A real-money prize on mainnet needs a legal review first. The profile's `prize` section is `enabled: false` (`true` includes it as `--with-prize` does). Its test mint is a placeholder, and it refuses Circle's mainnet USDC mint. `--with-prize` checks the `scripts/build-prize.sh --features epochs` artefact (SBPF v2, overflow checks, marker `PRZ_EPOCHS_TEST_USDC_BUILD`), then prints its deploy peak and rent per window. The send gate and its steps are the game program's only: this tool never deploys the prize program.

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

**Cost.** A first deploy needs ProgramData rent + Program rent + fees at its peak (12.31 SOL at 6,960 lamports per
byte for today's `.so`), not twice that: the CLI funds the buffer with the ProgramData rent and the deploy returns it
before the ProgramData is paid. A later upgrade holds a returned buffer float (`upgrade(temp)` in the plan).

There is no airdrop, no `--final` (the upgrade authority is the only `AnnounceSeason` signer, I-51, so an immutable
program could never start a season) and no season step: the operator tool for those does not exist yet (G4).

The full runbook: [`docs/frontier/devnet/DEVNET-DEPLOY-RUNBOOK.md`](../../docs/frontier/devnet/DEVNET-DEPLOY-RUNBOOK.md).
