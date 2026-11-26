# Devnet deploy runbook for permutation-frontier (DRAFT, 2026-11-18)

> **Status (2026-11-23): the PLAYABLE lane is deployed on devnet** — program `GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr`,
> upgrade authority `7sVNs9v5E3Euv5A2aeZEwmzABwc6zhDHskzqo8jz9CbA`, slot 525,401,809, `.so` sha256 `67a33c92…06b3`
> (§5; `scripts/devnet/devnet-playable-profile.json`). The S1 profile (`devnet-profile.json`) is still not deployed. The
> public play URL of that run is a Cloudflare **quick tunnel** (`*.trycloudflare.com`, no account): its name changes
> whenever cloudflared restarts (or the Mac reboots), so the herald's public host must be updated then, and no doc or
> profile should pin it; a stable name needs a named tunnel (a Cloudflare account, r0ze). Every step marked
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

> **Refreshed again 2026-11-21 against `origin/main` 436bb9c1 (offline; still nothing deployed, no key, no SOL).**
> Since the last refresh the season tool (#101), rim first villages (#104), keeper A's wide rings and wide claims
> (#107), its feed guard (#108, #121), the page's devnet path (#110, #118, #122), the keep capture's pace (#120),
> the rim → wide expedition's keeper steps (#121) and the read-only RPC client fixes (#123) were merged. **§7 now
> starts with a done / open table (§7.0)**, §4b gives the running cost per player and for the operator's keeper,
> and **§8 is the whole command list in order** (deploy → season → keeper A → herald, gateway, page). The only
> contact with devnet so far is read-only (the 2026-11-18 checks of §3 and the 2026-11-21 client checks of #123).

> **P14 (b), 2026-11-22 (owner decision 01:12 JST: P14 = both (a) and (b); offline, nothing deployed, no key, no
> SOL).** The devnet build no longer carries the Free City conquest kinds 12–18: `devnet-playable-sbf` =
> `expedition-dispatch-experimental` + `land-preview` (it was `conquest-dispatch-experimental` + `land-preview`). The
> version-2 wrapper refuses kinds 12–18 as `BadData` (custom error 1) before it reads any account, so no conquest
> record can reach keeper A's feed guard. **The devnet `.so` is therefore a new artefact: `file_sha256`
> `67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3`** (§1a; the old `da3dc1aa…b9741` must no
> longer be approved). **Deploying it — and any redeploy or upgrade that replaces an already-deployed devnet program
> with it — needs r0ze's explicit confirmation in chat for this exact sha256 at the time it runs**; nothing in this
> change deploys, funds or signs anything. Option (a) (keeper A reads the conquest records, PR #124) stays useful for
> the local land lane, which keeps the conquest kinds.

> **Refreshed 2026-11-22 against `origin/main` 6912906d (devnet-refresh-3; offline, docs only; still nothing
> deployed, no key, no SOL, no devnet contact).** Since the 11-21 refresh main gained keeper A's conquest reader
> (#124, P14 a), the devnet build without conquest kinds 12–18 (#139, P14 b, the new `.so` `67a33c92…06b3`), fog on
> the devnet page (#127), the page's devnet ExpeditionDepart and keeper A's `wide-resolve` role (#129, P15 + P9),
> keeper A's provinces on demand (#138, `provinces_reach`), the page's second / third village (#141, FileOutpost) and
> the 3-wide-ring cost model (#136). **No owner decision is pending**: what r0ze still does is the deploy-day list
> of §7.0 ("MUST at deploy") and the "deploy OK" for `67a33c92…06b3`. §4b now has every player step and every keeper A
> role's season cost (incl. #138's opens and #129's wide Resolves), and §8's `keeper.toml` lists the profile's 16 roles (13 of the keeper's `ROLES` and the 3 `WIDE_ROLES`; `explore`,
> `dormancy` and `sweep` are not in the profile). Verified 2026-11-22 on main 6d0e91f6 (verify-pr144; #137, merged after
> #139, changed the page, the launcher and the local chain only: nothing the devnet `.so`, the keeper or the planner links).

> **Refreshed 2026-11-23 against `origin/main` fbe51529 (devnet-refresh-4; offline, docs only; still nothing
> deployed, no key, no SOL, no devnet contact).** Since the 11-22 refresh main gained the public-endpoint hardening
> (#164, #166: the gateway's `--public-proxy xff`, §8a), keeper A's live rent rate (#147) and the page's / verifier's
> (#150), the wide village's own acts on the devnet page (#151, P17), the offline 72-bell capture and march pair
> (#160), the page's wait after Join (#172), the verifier's v0 / v1 and declared-patch reads (#155, #158, #169, #179),
> the dress rehearsal's runbook fixes (#177) and the season's end tool (#180, §6c). **The artefact is unchanged**:
> nothing under `permutation-frontier/src` or `frontier-abi` changed since #139, the committed
> `devnet-playable-67a33c92.so.gz` still unpacks to `67a33c92…06b3` (3,447,064 B), and the planner re-run at 5,080 and
> 6,960 prints the §4a figures unchanged. **No owner decision is pending.** New in §4b: the wide village's first
> WideMuster (0.0172 SOL, the dress rehearsal's D-dress-11) and keeper A's measured season. The deploy-day
> preflight (`scripts/devnet/preflight.mjs`, §8 step 0) is #181, merged the same day (main 14eb9bfe): start §8 there.

## 1. What gets deployed

| Program | Deployed? | Why |
|---|---|---|
| `permutation-frontier --features devnet-playable-sbf` (`scripts/build-frontier-devnet-playable-sbf.sh`, `program_version` 0x4804) | **yes, first** (owner decision B7) | The playable lane's devnet build (§1a): marker `PSF_DEVNET_PLAYABLE_BUILD`, no program-id check, **no Free City conquest kinds 12–18** (P14 b), deployable only through `scripts/devnet/devnet-playable-profile.json` |
| `permutation-frontier`, plain release build (`scripts/build-frontier.sh`, S1 rules, `program_version` 4) | deployable, **not first** (B7) | The only artefact the build calls `deployable yes`; a separate program with its own id and profile (`devnet-profile.json`) |
| `permutation-frontier --features localnet-land-sbf` (what `scripts/play-local.sh` runs) | no | Carries the `PSF_LOCALNET_*` markers (and the TEST-only `PSF_LOCALNET_WIDE_DEPART_BUILD`) and runs only under program id `[0x45; 32]`. Both profiles refuse it (exit 3) |
| `permutation-prize` | no (default); plan only with `--with-prize` | ⑰ reopened 2026-11-18 by the owner, devnet/test-USDC only; a mainnet real-money prize needs a legal review first. `dry-run.mjs --with-prize` checks the `--features epochs` build (`permutation-prize/target/deploy-epochs/permutation_prize.so`, marker `PRZ_EPOCHS_TEST_USDC_BUILD`) and adds its cost; it is never sent (no prize deploy step) |
| `wylls_resident_program` (NFT spike) | no | Not part of any devnet plan. ⑳ was reopened on 2026-11-18 18:26 JST as a devnet/local dry run only: `dry-run.mjs --nft-resident` plans the `nft-experimental` build and its send gate stays closed |
| `permutation-chain` (v9) | no | Superseded by `permutation-frontier` |

The release build measured on 2026-11-18 (this branch, solana-cargo-build-sbf 3.1.9, platform-tools v1.52):

| | value |
|---|---|
| `so_len` | 1,413,240 B |
| `--max-len` (round_up(1.25 × so, 4 KiB)) | 1,769,472 B |
| ProgramData length | 1,769,517 B |
| `file_sha256` | `850532f0eb2e2b66a263af6778147f6ae1cace9bc54294966ead6be87612a644` |
| `program_hash` (trailing zeros stripped) | `ea5bd0ddba5d4ef45e27213c1a4805c39741bff69e60a2bb8d063734683c7e78` |

(Rebuilt 2026-11-22 by the P14 b run, `scripts/build-frontier.sh`, on `origin/main` 55200a43 plus P14 b, which does
not change this artefact; the values this table had before, `4483c842…` and 1,409,560 B, were the 2026-11-18 build
and had gone stale. ABI-ALLOCATION rev 8 already records `850532f0…a644`.)

Another toolchain or another commit can give another hash. Before approving, run the build again and approve the
hash it prints. (An independent rebuild on 2026-11-18 from a fresh checkout gave the same two hashes.)

### 1a. The playable lane's build (B7; P14 b; measured 2026-11-22 on `origin/main` 55200a43 + the P14 b change)

`scripts/build-frontier-devnet-playable-sbf.sh --twice` (solana-cargo-build-sbf 3.1.9, platform-tools v1.52, offline,
key-free), both builds identical:

| | value |
|---|---|
| `so_len` | 3,447,064 B |
| `--max-len` | 4,308,992 B |
| ProgramData length | 4,309,037 B |
| `file_sha256` (the value for `--approved-sha256`) | `67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3` |
| `program_hash` | `8dcaef873758b981df191a33f5e38bfb90afbf9ae673d2589641adf9f40174bb` |

These are the bytes of `frontier-node/fixtures/verify/devnet-playable-67a33c92.so.gz`, the `.so` that
`stack/tests/operator_playable.rs` deploys and `verify/tests/p14b_devnet_no_conquest.rs` re-executes. **Deploying it
needs r0ze's confirmation in chat for this sha256** (a redeploy or upgrade over an already-deployed program too).
It differs from the previous devnet build (`da3dc1aa…b9741`, 3,657,488 B, `program_hash` `786ef80f…`, the
fixture `devnet-playable-da3dc1aa.so.gz`, which stays committed because the recorded verifier seasons were made on
it) only by P14 (b): no `conquest-dispatch-experimental`, so the wrapper's Free City kinds 12–18 answer `BadData`
and the conquest table keeps its original version-1 layout (1,664 B, no siege reservation region). The S1 release
and the localnet land lane are byte-identical to main's (`850532f0…a644`, `6fb9e6cc…0157`). The hash changes with
any edit the build links (even a comment line that moves a panic's file:line), so build again right before
approving. The text below, up to "Two tool versions", is the 2026-11-21 state of the PREVIOUS build (`da3dc1aa`). **State on 2026-11-21 (`origin/main`
436bb9c1):** the last commits that touch what the build links (`permutation-frontier`, `frontier-abi`,
`permutation-rules`, the two build scripts) are #113's and #119's; verify-pr119 rebuilt the devnet `.so` on #119's
head with main merged (76933cf5) and got `da3dc1aa…b9741` again, and nothing linked has changed since (`git log
c8fdbf2a..436bb9c1` over those paths is empty). It was not rebuilt on 2026-11-21 itself. The build differs from the local-play lane (`localnet-land-sbf`) by cargo features of
`permutation-frontier` only: it has `devnet-playable-sbf` and lacks `localnet-expedition-sbf`,
`localnet-conquest-sbf`, `localnet-land-sbf` and the TEST-only `localnet-wide-depart` (every dependency resolved
the same features until P14 (b); since then `frontier-abi` also lacks `conquest-dispatch-experimental` in the
devnet build). In code that is the `[0x45; 32]` program-id check, the markers and WideDepart's debit gate
(`proc::wide::DEPART_DEBIT_ENABLED`, closed here: wide → wide marches answer `NotImplemented`), and since P14 (b)
the Free City conquest kinds 12–18 (`conquest-dispatch-experimental`, absent here: `BadData`). `lib.rs` refuses to
compile `devnet-playable-sbf` together with a localnet lane, `localnet-wide-depart`, `nft-experimental`,
`conquest-dispatch-experimental` (P14 b) or any
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
that key the buffer's authority, and the buffer authority signs **every** Write transaction (about 1,660 of them) and
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
`.so` (P14 b's `67a33c92…`: 4,056 Write transactions, 8,117 signatures; the previous `da3dc1aa…` needed 4,303 and 8,611):

| lamports/byte | ProgramData | Program | Fees | **Peak the payer needs** | Stays locked | Later upgrade float | One season `S1_DEVNET_WIDE_7D`, 50 players | **Deploy + one season** |
|---|---|---|---|---|---|---|---|---|
| **5,080 (measured 2026-11-18)** | 21.8905 | 0.0008 | 0.0405 | **21.93 SOL** | 21.89 SOL | 17.51 SOL | 98.21 SOL | **120.15 SOL** |
| 6,960 (worst case, SIMD-0438) | 29.9917 | 0.0011 | 0.0405 | **30.03 SOL** | 29.99 SOL | 23.99 SOL | 106.24 SOL | **136.28 SOL** |

(`dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json --rate 5080` / `--rate 6960` on 2026-11-22,
offline. The previous `.so` cost 23.29 / 31.89 SOL at the peak.)

At 5 SOL per faucet request: 5 requests for the deploy at 5,080 (7 at 6,960), 25 for deploy + one season (28). Of a
season's 98.21 SOL only 0.625 SOL (fees and tips) is spent; the rest is returned at the season's end or float (a continuous world never ends, so nothing is returned: EndSeason is refused, §6). A world that never ends
adds 1.02 SOL per day of AnchorArchives (1.40 at 6,960) [model].

### 4b. Running cost: each player, and the operator's keeper A (2026-11-21; refreshed 2026-11-22)

Every figure is **measured offline** on the §1a `.so` in an in-process local chain at 5,080 lamports per byte
(`stack/tests/operator_playable`, runs P3–P11; each was repeated by an independent verify run, and the per-player
totals matched to the lamport). The 6,960 column is **computed** by scaling the rent part. Nothing was measured on
devnet. Fees are the 5,000-lamport signature fee unless the keeper bids a priority fee.

**A player** (wallet-paid: the connected wallet is fee payer and actor, the operator sponsors nothing; O11 below).

| Step (who sends it: the page, with the player's wallet) | Lamports at 5,080 | at 6,960 (computed) | What it is |
|---|---|---|---|
| Join | 2,605,960 | 3,568,520 | fee + the Citizen's rent (384 B) |
| First village: PlaceHome (heartland) or the rim FileTicket | 7,157,640 | 9,804,680 | fee + the Holding's rent escrow (1,280 B); the rim FileTicket at both rates **measured offline** (PPOST, rent-live-rest: the page's escrow preview = the wallet's debit − the fee, at 5,080 and at 6,960) |
| Harvest, Build, Train, Muster | 5,000 each | 5,000 each | fee |
| Depart (one sealed march; the return home is another Depart) | 50,394 | not computed | fee + the escrowed tip and seal bond, settled by the program |
| WideClaimSite (one wide village) | 9,108,360 | 12,477,320 | fee + the ticket record's rent and escrow (1,792 B) |
| FileOutpost (a second or third village past the heartland, #141; keeper A's `tickets` role settles it) | 7,157,640 | 9,804,680 | fee + the Holding's rent escrow (1,280 B); PPOST, verify-pr141: the page's preview total = the wallet's debit (rent-live-rest: also at 6,960, measured offline) |
| ExpeditionDepart (rim → wide; the page sends it on devnet, §7 P15) | 2,407,514 | not computed | fee (5,000) + the escrowed tip and bond (45,394) + the rent of the 336-byte transit record (2,357,120) |
| The **first** WideMuster in a wide province (P17, #151; it creates the province's roster from the sender's wallet, so every later muster there, by anyone, is fee-only) | 17,155,080 | 23,501,960 | fee + the rent of the province's 3,248-byte wide roster ((3,248 + 128) B × the rate); **measured offline** at 5,080 (devnet-dress-rehearsal run6, D-dress-11: the page's preview total = the wallet's debit) |
| **Join → rim village → 10 Harvests → wide claim** (#110, verify-pr110) | **18,921,960 (0.0189 SOL)** | 25,900,520 (0.0259) | |
| **Join → rim village → 5 Harvests → Muster → one march** (#118, verify-pr118) | **9,843,994 (0.0098 SOL)** | not computed | |
| Join, one village, one march, one wide claim and one expedition, with about 20 fee-only actions (no outpost, no first WideMuster) | about 21.4 M (**0.021 SOL**) [sum] | about 0.03 SOL | |
| Every row above once (with one outpost and one first WideMuster), with about 20 fee-only actions | about 45.7 M (**0.046 SOL**) [sum] | about 0.063 SOL [sum; the two "not computed" rows scaled by their rent part] | |

So a wallet with **0.05 SOL of devnet SOL** covers a player's season with room to spare **as long as the player
does not muster from a wide village**: the dress rehearsal's busiest such page spent 17.26 M lamports (0.0173 SOL).
With a wide province's first WideMuster (0.0172 SOL more) a player who does everything spends about 0.046 SOL at
5,080 (the rehearsal's wide page: 36,567,040 lamports with one wide village) and about 0.063 SOL at 6,960, so **tell players
who go to the wide land to hold 0.1 SOL**. The Citizen's and Holding's rent comes back when they are closed after
the season (PLAYTEST-RUNBOOK §3 step 14).

**The operator** (r0ze's keys: the deployer, the upgrade authority, and keeper A's payers).

| Line | SOL at 5,080 | at 6,960 | Kind | Source |
|---|---|---|---|---|
| Deploy, peak the deployer needs (21.89 / 29.99 stays locked; P14 b's `.so`, it was 23.29 / 31.89 for `da3dc1aa…`) | 21.93 | 30.03 | locked rent | §4a |
| Season setup, 10 transactions from the upgrade authority | 57.14 | 57.19 | 57 float (1 bond returned, 36 wedge funds, 20 DefencePool returned if unspent) + rent | §6b, #101 |
| Keeper A's pools: reveal 150 payers × up to 0.016, delay 32 × up to 0.1, beneficiary 0.1 | 5.7 | 5.7 | float | profile `season.lamports`, halved (it models keepers A and B) |
| Keeper A `beacon` / `archive`: AnchorArchives, BellAnchors, SeedCaches | 20.89 | 28.62 | float [model] | §4a's season lines |
| Keeper A `rings`: RingSeeds 0–128 and the wide ring seeds (§4a's model counts the three the profile's `wide_rings` = 3 opens, rings 129–131; it counted four, 129–132, until 2026-11-21) | 0.17 | 0.24 | float | §4a; P5: 1,632,371 lamports per wide ring request (1,625,600 of it rent) |
| — of the line above, **never returned**: the three wide ring seeds' rent (`PSFXWRS1`, 192 B; the program has no close for them, D-end-1; the legacy RingSeeds 0–128 come back to keeper A at CloseSeason part 8) | 0.0049 | 0.0067 | locked for good, every season | 3 × 1,625,600 = 4,876,800 lamports at 5,080; 3 × 2,227,200 = 6,681,600 at 6,960 ((192 + 128) B × rate; verify-pr180). A season with more wide rings strands 1 more seed rent per ring |
| Season end, `frontier-operator end-season` (§6c): EndSeason, then the province closes and CloseSeason parts (about 50 transactions for 79 legacy + 108 wide provinces) | 0.000255 | same | spent (fees); everything the setup line above put in comes back but the defence pay claimed | PEND: 5,000 + 250,000 lamports |
| Keeper A opening the 42 rim and 108 wide provinces: what its own payers send | 0.014 | 0.015 | 0.009 of fees spent; the rest (0.005 at 5,080) is the three wide ring seeds' rent, already in the line above | P4 (26,332 per rim province), P5 (12,517,785 for the three wide rings: 3 requests with their rent, 3 consumes, 108 opens) |
| — their rent: 1.04 + 2.74 SOL, **out of the 36 SOL of wedge funds, not new money** | (3.78) | (5.17) | float | #104, #107 |
| Keeper A per rim first village (SettleTicket) / per wide claim (settle + finalize) | 0.000008 / 0.000015 | same | spent | P4 8,361; P5 14,663 lamports |
| Keeper A per sealed march: Reveal, SettleDeparture, SettleTransit, CloseArrivalSlot | 0.0027 | — | mostly the ArrivalSlot's rent, closed later | P9 |
| Keeper A per **contested bell** (GatherClash + ResolveFromInputs) | 0.0065 | — | ClashInputs rent (returned at the season's close) | P9: 71,627,322 over 11 gathers |
| — so one keep held to its capture (72 bells) | about 0.47 [derived] | — | float | 72 × the line above |
| Keeper A `skip`: SkipQuiet over every opened legacy province (79: genesis 37 + rim 42) | about 0.55 per 7-day season | same | spent (fees) | P9: 2,373 sends, 38,611,083 lamports; **not in §4a's total** |
| Keeper A per rim → wide expedition | 0.046 | — | mostly rent (ClashInputs, ArrivalSlot / ArrivalDay, 19 wide Resolves) | P11, verify-pr121: 45,634,216 lamports |
| Keeper A `rings` `provinces_reach = 3` (#138): OpenProvince next to the settled land, what its payer sends | at most 0.011 | at most 0.0006 (23 opens; keeper A's floor follows the cluster's rate since keeper-rent-floor) | spent (fees): 26,332 lamports an open | PPROV; a season total of at most 413 opens (305 once the wide rings are open) at 5,080: the wedge-fund floor, not `provinces_max`, is the bound, and keeper A stops opening in a wedge whose fund reached it (§6: what that means for play). At 6,960 the floor (read from the Rent sysvar) allows 23 before the wide rings and none after (§6; before keeper-rent-floor the keeper would have allowed 281, F1) |
| — their rent: 24,709,120 lamports a province, **out of the 36 SOL of wedge funds, not new money** | (at most 10.2) | (at most 0.78) | float | 413 × 24,709,120; 23 × 33,853,440 [derived] |
| — SkipQuiet for those provinces | about 0.3–2.9 per 7-day season | — | spent (fees); **not in §4a's total** | verify-pr138: 0.00067 (idle) to 0.0070 (busy) SOL a province × 413 |
| Keeper A `wide-resolve` (#129): the quiet wide Resolve of every known wide province, every bell | about 0.065 per known wide province per 7-day season; at most about 7.0 (all 108) | same | spent (fees): 64,331 lamports a bell and province (5,000 + the class-D starting bid on the role's 600,000 CU limit; a quiet Resolve uses about 84,000 CU) | verify-pr129; **not in §4a's total** |
| Fees and tips over 7 days, 50 players | 0.625 | 0.625 | spent [model] | §4a |
| Keeper B's pools (5.7) and the relay pool (7.5) | 13.2 | 13.2 | float, **optional**: a first devnet season runs keeper A alone, and the wallet-paid devnet routes are not funded routes (`app.mjs`: "wallet-paid, so not a funded route") | §4a |
| Herald, gateway, page | 0 | 0 | they sign nothing on the devnet play path | |

§4a's **120.15 SOL (136.28 at 6,960)** (P14 b's `.so`; 121.50 / 138.13 for `da3dc1aa…`) stays the figure to hold for the deploy and one season. It includes the
optional 13.2 SOL above and 0.49 SOL of player rent that the players now pay themselves, and it leaves out the
SkipQuiet fees (0.55), the ClashInputs float of contested bells and the expeditions (0.046 each); for a small first
season the two sides roughly cancel. Without keeper B and the relay pool the operator needs about **106.5 SOL plus
the war's float** at 5,080 [sum of the lines above]. **Since #129 and #138 keeper A's fee payer also needs a budget
outside §4a's total:** SkipQuiet over the provinces opened on demand (up to about 2.9 SOL) and `wide-resolve` (about
0.065 SOL per known wide province, up to about 7.0 SOL if all 108 are known from the first bell). Budget **about +3
SOL** for a small first season (a few wide villages) and **up to about +10 SOL** for a full one; at 5,080 the 120.15
SOL hold then becomes about 123–130 SOL [derived]. Re-run 2026-11-22 (devnet-refresh-3, offline, on the committed
`devnet-playable-67a33c92.so.gz`): `dry-run.mjs --profile … --so … --rate 5080` → season 98.2147, total 120.1467 SOL;
`--rate 6960` → 106.2416, 136.2751 SOL; `SEND GATE: CLOSED`. Re-run again 2026-11-23 (devnet-refresh-4, `origin/main`
fbe51529): the same figures at both rates.

**Keeper A, one whole season measured offline** (devnet-dress-rehearsal run4, 2026-11-23: the §8 keeper.toml with
`wide_rings = 1`, five pages and two external residents, bell 0 to 1,012, rent 5,080): **17,041 transactions, 0.881
SOL out of its payers, of which 0.273 SOL is fees** (spent) and the rest is rent that its `close` role returns
while it keeps running (it must drain before `end-season`'s final part: after the tombstone nothing closes those
floats, §6c step 3). By role: SkipQuiet 13,852 sends / 0.225 SOL; GatherClash 78 / 0.537 SOL (ClashInputs float);
`wide-resolve` 200 × 64,331 lamports; 2,489 refused ArchiveAnchors ≈ 0.023 SOL (the harness's declared anchors; an
offline-only refusal; keeper A's backoff then capped at 1,024 slots for every refusal, D-dress-8 — fix-keeper-backoff holds a deterministic refusal up to ≈ 1 h / 64 passes and probes a refused kind one key at a time, RUN-A-KEEPER §3). That season was
small (7 players, 36 wide provinces, few of them known): the "+3 SOL" budget above stays the figure to fund, and the
"+10 SOL" bound is `wide-resolve` over all 108 wide provinces from the first bell (about 7.0) plus SkipQuiet over
every province opened on demand (about 2.9). Not measured there: the beacon's
anchors and seeds (declared offline), so the 20.89 SOL beacon / archive float stays a model figure.

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
scripts/build-frontier-devnet-playable-sbf.sh --twice                 # note file_sha256 (§1a; P14 b: 67a33c92…06b3)
# [r0ze] confirm in chat: deploy (or redeploy / upgrade) of exactly this file_sha256
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
and `--max-len 4308992` (P14 b's `.so`; it was 4575232 for `da3dc1aa…`); the authority signs about 4,056 Writes. The L(kind) cap of 1,441,792 B below is the S1
profile's; the playable profile's cap is 8,388,608 B.

The script runs these and stops at the first failure: `solana --version` (4.0.0 or newer), `solana address` on both
key files (they must match the profile), `solana balance`, then this deploy command:

```sh
solana program deploy permutation-frontier/target/deploy/permutation_frontier.so --url https://api.devnet.solana.com \
  --keypair deployer.json --fee-payer deployer.json --program-id program.json --upgrade-authority authority.json \
  --max-len 1765376 --max-sign-attempts 50 --commitment confirmed
```

**No `--use-rpc` on the public endpoint** (devnet-deploy-1/-2, 2026-11-23). With `--use-rpc` every buffer write goes
through `https://api.devnet.solana.com`'s `sendTransaction`, which the public endpoint throttles (HTTP 429): the first
real deploy landed about 17 of 4,056 writes in 16 minutes and stopped with `Data writes to account failed: Custom
error: Max retries exceeded`. Without it the 4.x CLI sends the writes to the leaders' TPUs over QUIC and uses the RPC
only to confirm: the playable `.so` (67a33c92…06b3) then landed in **40 seconds** (`--max-sign-attempts 50`,
`--with-compute-unit-price 5000`; 21.9314 SOL out of the deployer = 21.8906 ProgramData rent + 0.0008 Program rent + about 0.040 SOL of fees and priority fees). `dry-run.mjs` runs this form since devnet-deploy-2.

**Run it by hand with a buffer keypair** when you can: `solana-keygen new --no-bip39-passphrase -o buffer.json` and add
`--buffer buffer.json` to the deploy line. The deploy is then resumable (run the same line again: the CLI rewrites only
what is missing), and the 4.x CLI does **not** print a recovery phrase. Without `--buffer` it prints the random
buffer's **12-word recovery phrase** to stdout at the start, so never keep an unredacted log of a deploy.
The live playable deploy (2026-11-23 19:32 JST, slot 525,401,809) was:

```sh
solana program deploy permutation-frontier/target/deploy-devnet-playable-sbf/permutation_frontier.so \
  --url https://api.devnet.solana.com --keypair deployer.json --fee-payer deployer.json \
  --program-id program-playable.json --upgrade-authority authority.json --buffer buffer-playable.json \
  --max-len 4308992 --with-compute-unit-price 5000 --max-sign-attempts 50 --commitment confirmed
```

Then `solana program show <PROGRAM_ID>`, and `solana program dump <PROGRAM_ID> <tmp>`. The dumped bytes, with
trailing zeros stripped, must hash to `program_hash`.

**If a deploy fails half-way**, the buffer keeps its SOL. `solana program deploy` makes the upgrade authority the
buffer's authority too (agave v3.1.9 `cli/src/program.rs`, `process_program_deploy`), so closing it needs
`authority.json`:

```sh
solana program show --buffers --buffer-authority "$(solana address -k authority.json)" --keypair deployer.json --url https://api.devnet.solana.com
solana program close --buffers --authority authority.json --recipient "$(solana address -k deployer.json)" --keypair deployer.json --url https://api.devnet.solana.com
```

Always pass `--keypair deployer.json` and the explicit URL: without them the CLI pays from its default config key and
cluster (a mainnet default on some machines). A deploy started with `--buffer buffer.json` can instead be **resumed**
by running the same deploy line again.

**Upgrading** (between seasons, or mid-season only if `PROGRAM_VERSION` and every layout stay the same:
PLAYTEST-RUNBOOK §6):

```sh
solana program deploy <new .so> --program-id <PROGRAM_ID address> --upgrade-authority authority.json --keypair deployer.json --url https://api.devnet.solana.com --max-sign-attempts 50
```

An upgrade writes a new buffer first, so the deployer needs the buffer's rent at its peak, `(128 + 37 + so_len) × rate`
(17.85 SOL for a 3,514,376 B `.so` at 5,080; 21.89 SOL is the FIRST deploy's ProgramData rent at max_len, not an upgrade's
peak), on top of the fees (≈0.04 SOL); the upgrade returns the buffer's lamports to the spill account (the deployer) when it
lands. Where SIMD-0433 (`EhisBfVtGvEA8bVCVN5VMaYEaX6iTfoUrmcDi8LY7Kxy`, Loader V3 Set Program Data to ELF Length) is
active the upgrade also cuts the ProgramData to the new ELF length and returns the difference's rent; a later larger
`.so` then needs an extend. Measured on a local agave 4.4.1 validator by devnet-new-world-plan; the new world's upgrade
and creation steps: NEW-WORLD-RUNBOOK.md.

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
(cd frontier-node && cargo build --locked --release -p stack --bin frontier-operator)
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

**What it costs** at the preset `S1_LOCAL_7D`, 5,080 lamports per byte (the plan prints the cluster's own rate when
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
provinces to ring 128 would cost 1,224 SOL). **On demand is keeper A's job (devnet-open-province):** a second or third
village (FileOutpost: ring > `heartland_max_ring` 3, within `outpost_range` 3 of the home) and a ⑭ R3 home past the
heartland need a present Province, so the same duty's `provinces_reach = 3` opens every absent province of a seeded
legacy ring within 3 provinces of a settled one (`keeper::rings::demand_plan`), at most `provinces_per_pass` (12) a
scan and `provinces_max` (600) a run, never below a wedge fund's floor (`demand_fund_floor`: the largest balance check
still ahead plus the rim's and wide rings' shares, 3.95 SOL per fund at 5,080, 5.41 SOL at 6,960) and never while the
feed guard holds automatic writes. Rent from the wedge funds (24,709,120 lamports a province at 5,080, 33,853,440 at
6,960), fees from keeper A's payer. **The floor and every rent it compares are the cluster's** (keeper-rent-floor):
keeper A reads the Rent sysvar (one `getMultipleAccounts` key, re-read every 1,500 slots ≈ 10 min) and prices the floor,
each open's rent and the crowding OpenRing check at that rate; it never uses the compile-time 5,080. If the sysvar cannot
be read (never, or not for 9,000 slots ≈ 1 h) keeper A opens nothing on demand and no crowding ring, `/v1/status`
`duties.rent.usable` is false and the `rent-unknown` alert is raised; its other duties go on.
The floor, not `provinces_max`, is the real bound (verify-pr138, recomputed by verify-pr144): at 5,080 a season's
on-demand opens total at most 413 (69 a wedge, 68 in wedge 0) if they all come before the wide rings open; once the
108 wide provinces are open (about 21 h in) the total, counting the opens already made, is at most 305 (51 / 50 a
wedge). At 6,960 at most 23 before the wide rings and none after (keeper A computes the 6,960 floor itself since
keeper-rent-floor; before it, the keeper kept the 5,080 floor at any rate and could have opened 281 / 173 at 6,960,
draining the funds below OpenRing's and the wide ring seeds' checks: D-verify-pr144-1, offline proof
`operator_playable` PFLOOR at 5,080 and 6,960). `provinces_max` counts per keeper run. **What the floor means for
play:** the bound is per wedge. When a
wedge's fund is at its floor keeper A stops opening provinces in that sixth of the map for the rest of the season
(nothing refills the funds; the other wedges go on). `GET /v1/status` then shows `provinces_demand.waiting` =
"wedge fund N at its floor (… lamports at R lamports/byte)"; the page keeps saying 「この州はまだ開かれていません」 for those provinces (its
"opens automatically" no longer holds there), and a FileOutpost into them is refused before signing
(`LocalActProvinceAbsent`; on chain `BadAccount`, as for any act that needs the absent Province). Villages, marches and the wide claim on provinces already open
are not affected. A heartland home's outposts lie on rings 4–6, whose reach is rings 4–9, 234 provinces, about 39 a wedge:
under the floor at 5,080; rim homes and R3 homes past the heartland are what can reach it [derived]. At 6,960 the
floor leaves room for only about 23 opens in total, so second villages past the heartland mostly stay closed unless
the funds are larger (a preset / `.so` change, blocked on r0ze). OpenProvince stays
permissionless, so anyone may still open a province by hand from the same fund, below the floor too.
OpenProvince stays permissionless: anyone may also send it. **Rim first villages (Q-W1):** once ring 128 is opened and seeded, the
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
change: the `.so` and its sha256 are unchanged. One 50-player season of this preset is **98.21 SOL** at 5,080 (106.24
at 6,960), 15 SOL more float than `S1_LOCAL_7D`. `frontier-operator --preset S1_DEVNET_WIDE_7D` creates this
season (§6b).

**The devnet world is continuous (devnet-continuous-1, 2026-11-24; owner 2026-11-23 22:42 JST: seasons abolished, t481u
Q11 「変更しよう」).** The profile's preset is now `S1_DEVNET_WIDE_CONTINUOUS` = `continuous(S1_DEVNET_WIDE_7D)`
(`frontier-abi/src/v2/presets.rs`): the same world with exactly three bytes changed, conquest byte 80 `continuous = 1`
and `end_bell` = `join_close_bell` = 4,294,967,295 (`NO_END_BELL`). Joins never close; EndSeason is refused at every
bell (`CqError::ContinuousWorld`, 94), so §6c never applies to it and CloseSeason never returns the 36 SOL province
fund / 20 SOL defence pool float. The deployed program (base 6912906d, .so 67a33c92) already accepts it (commit
2c29496f; `devnet_preset_wide.rs` `s1_devnet_wide_continuous_never_ends_and_keeps_growing` on that .so). Season 1
was announced with the 7-day preset; AnnounceSeason pins the params hash, so the continuous world is season **2**
(`operator.seasonId` 2) with its own announce and 24 h lead. Season 1 was **aborted** on 2026-11-24 06:34 JST (devnet-s1-cancel-1, owner t486u): AbortSeason by the authority while Announced, bond outcome RETURNED (1,000,000,000 lamports back to the authority `7sVNs9v5…`; tx `54y4Whm3GPy7tQkvmkc9CJUYd74tD1tmUqMCgJFahvAQhdtXLASKwMrupdmfj2GndzEnhHzWJLf7BRLBKka4WujV`, slot 525,567,060). The rule (`permutation-frontier/src/proc/season.rs` `abort_season`): the authority may abort while Announced, or Created/Seeded before `genesis_ts`; the bond returns only while `now <` the genesis round time (for an Announced season the earliest round CreateSeason could fix, `genesis_seed_round(t_create_min, 60)`, about t_create_min + 660 s) and is burned to the incinerator after; anyone may abort an Announced/Created season once `now ≥ t_create_min + 7 d` (bond burns). No `frontier-operator` command sends AbortSeason; the one-off sender is `scripts/devnet/abort-season-1.mjs` (pinned to season 1 and to devnet; dry run (read + simulate) by default; a send needs `--key`, `--yes-send`, `--i-have-r0ze-approval` and `--approved-sha256` of the deployed program, as `end-season`; it refuses unless season 1 is Announced with its stored authority and t_create_min, so it refuses now that season 1 is Aborted). The aborted Season 1 account still holds its 11,054,080-lamport rent; CloseSeason's final part may shrink it to the tombstone later (optional). When the world changes season id, also
re-point the services (herald/gateway `--season`, keeper.toml `season`, a fresh herald `--data` dir) and the health
monitor (`scripts/devnet/health.mjs` pins the Season address and its CreateSeason time). Every "per 7-day season" fee below repeats each week.
If the world creation is postponed on purpose (the driver stopped by hand, CreateSeason not sent — owner decision
2026-11-24 12:07), tell the monitor: `health.mjs --no-world-yet`, or a marker file `<run-dir>/world-postponed` /
`<logs>/devnet-create-postponed` (scripts/devnet/README.md "World creation postponed"). It then expects no driver /
gateway / keeper A, FAILs if the driver runs, and prints the two deadlines of the announced season: the bond comes back
by AbortSeason only before the genesis round time, and CreateSeason can land for 7 days. Remove the marker before the
driver is started again.

### 6b. The playable lane's season: `frontier-operator --preset S1_DEVNET_WIDE_CONTINUOUS` **[r0ze, only after §5a]**

Built with the stack crate's `playable-lane` feature (the wide-land ABI tables; it also enables `keeper/playable-lane`). It reads
`scripts/devnet/devnet-playable-profile.json` (its `operator` block: `seasonId` 2, `beacon` quicknet;
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
K=~/wylls-devnet-keys/authority.json                      # the upgrade authority of §2; mode 600, outside the repository
H=<the sha256 r0ze approved in §5a, today (P14 b) 67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3>

$B --profile $P --offline        # the plan at rent.assume, no RPC
$B --profile $P --authority $K   # dry run on devnet: the cluster's rent, the balance, the deployed program's sha256
                                 # and markers, "SEND GATE: OPEN/CLOSED"; sends nothing
$B --profile $P --authority $K --yes-send --i-have-r0ze-approval --approved-sha256 $H --record ~/wylls-season-2.jsonl
#   → AnnounceSeason; exit 3 "CreateSeason opens at chain clock T"
# 24 h 5 min later, the same command:
#   → CreateSeason, InitBeaconLogs, InitShards × 6; exit 3 "WideSetRules needs the season Seeded"
# start keeper A (§7; built from this code or later with the wide duties:
#   (cd frontier-node && cargo build --locked --release -p keeper --features playable-lane --bin frontier-keeper)),
# with the profile's roles (beacon, archive, rings, fold, tickets, wide-tickets, and the legacy war's reveal, settle-departure,
# gather, resolve, skip, settle, close, claims — runbook §7 P12 — the rim → wide expeditions' `expeditions`, §7 P13, and `wide-resolve`, §7 P9)
# and rings duty (extend = true, extend_max_ring = 128, lazy_provinces = true, rim_per_wedge = 6, provinces_reach = 3, wide_rings = 3,
# wide_per_wedge = 6); a keeper built without the feature refuses `wide_rings`, `wide-tickets`, `expeditions` and `wide-resolve`. About 21 min after T it consumes the genesis round.
# Then the same command once more:
#   → WideSetRules; exit 0 "setup complete"; any later run prints "setup complete: nothing to send"
```

On devnet a send needs all three of `--yes-send`, `--i-have-r0ze-approval` and `--approved-sha256`; without them the
tool refuses before it reads the key file or contacts the cluster. A loopback `--rpc` that reaches devnet (an SSH
tunnel, a local proxy) gets the same gate: the cluster's genesis hash decides, so such a send is refused right after
`getGenesisHash`. `--approved-sha256` must equal the sha256 of the
ELF in the deployed ProgramData, and the deployed program must carry `PSF_DEVNET_PLAYABLE_BUILD` and none of the
profile's refused markers. The dry run prints both hashes of the deployed program: the file's `sha256sum`
(`67a33c92…` since P14 b, the one to approve; `da3dc1aa…` before) and `solana-verify get-program-hash`'s (trailing zero bytes stripped: `8dcaef87…`; `786ef80f…` before,
the `program_hash` of §1a). Everything in §6 holds too (URL and genesis guards, key-file guard, idempotent re-runs,
`--wait`, `--max-txs`). `--t-create-min UNIX` fixes `t_create_min` (≥ the chain clock + 24 h + 60 s); the plan then
prints the genesis round it fixes. `--record FILE` appends one JSON line per landed transaction (signature, slot,
compute units, fee, lamports). `--rpc` is `--cluster-url`; `--preset` overrides the profile's preset.

**Tested offline only** (`frontier-node/crates/stack/tests/operator_playable.rs`, CI key-tests): the committed devnet
`.so` (`frontier-node/fixtures/verify/devnet-playable-67a33c92.so.gz`, the §1a artefact since P14 b; the runs
measured below were made on the previous `da3dc1aa…`, whose expedition kinds 0–11 the new build runs with the same
recorded account states, `verify/tests/p14b_devnet_no_conquest.rs`) in an in-process
frontier-localnet; this command with `--rpc` on loopback; then the real `frontier-keeper` (`feed = "rpc"`, the
devnet rings duty) with a local `drand-replay` serving the committed real quicknet rounds (the season's
`t_create_min` is chosen so its genesis round is one of them) seeds the season and opens the genesis rings; the
operator's WideSetRules lands; the real `frontier-herald` (`--source rpc --cluster devnet`) folds the season; a test
participant Joins and places a first home in the heartland. Keeper A's ConsumeGenesisSeed took 329,539 CU.

**Provinces on demand (devnet-open-province), tested offline too** (the same file, PPROV, ports 41540+; keeper A with
the profile's roles, `rim_per_wedge = 6` and `provinces_reach = 3`). After P3's setup and P4's declared map growth,
RingSeed(4..=10) are a **declared patch** (copies of ring 3's seed; on devnet the rings duty seeds them one a bell).
The participant's home is at (−2, 0), ring 2. Its FileOutpost into the absent ring-4 province (−4, 0) is **refused**
(`BadAccount`, code 2) on the exact devnet `.so`. Keeper A then opens the 14 absent provinces of rings 4–10 within 3 of
the home and nothing farther (OpenProvince 140,606–148,207 CU, 26,332 lamports of fee each, 24,709,120 lamports of rent
each from the wedge funds, 17.5 s wall). The same FileOutpost lands (20,752 CU, 7,157,640 lamports: fee + the
Holding's rent escrow) after 6 Harvests. The ticket bell's anchor and seed are a declared patch, as in P4.
**Keeper A's `tickets` role settles it** (SettleTicket 22,588 CU): the second village, order 2. Then keeper A opens
the 14 provinces within 3 of the new village. The page's devnet path sends FileOutpost since #141
(`DEVNET_ACT_COMMANDS`, operator_playable PPOST).

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
round per bell (§7 R1).

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

### 6c. The season's end and clean-up: `frontier-operator end-season` **[r0ze: key + approval for every send]**

(Finite seasons only. The continuous devnet world, season 2, never ends: `end-season` reports EndSeason as blocked,
`ContinuousWorld`.)

(devnet-end-season, D-dress-6: before this there was no tool and no step; the dress rehearsal's Season stayed
Seeded at bell 1,012.) What the program allows (`permutation-frontier/src/proc/season.rs`, `proc/map.rs`,
`proc/wide.rs`; code wins over the m1 PLAYTEST-RUNBOOK §3 steps 13–15, which says the same in short):

| when | instruction | who may sign | what moves |
|---|---|---|---|
| bell ≥ `end_bell` (1,008 = 7 days after genesis) | **EndSeason** (0x04) | anyone (`TooEarly` before; `AlreadyDone` after) | status Running → Ended; only its 5,000-lamport fee |
| Ended, the 72 h grace | nothing closes (`TooEarly`) | — | the Provinces stay readable (a ⑰ prize tally would run here; keeper A still claims defence pay and closes its own floats) |
| `end + 72 h` | **CloseProvince** (0x24) for every legacy Province, **WideClose(6)** (0xDE) for every wide province | anyone | each Province's rent → its wedge's ProvinceFund (`provinces_opened − 1`) |
| `end + 72 h` | **CloseSeason** parts 0–5 (48 JoinShards), 6 (16 BeaconLogs), 8 (RingSeeds) | the Season's stored authority (= the upgrade authority that announced it) | shards / logs → authority; each RingSeed → its stored payer (keeper A) |
| after every province is closed | **CloseSeason part 7** (final) | authority | Frontier, the 6 ProvinceFunds, the DefencePool → authority; the Season shrinks to a 128-B tombstone, everything above its rent (the 1 SOL creation bond included) → authority |
| on the tombstone | CloseSeason parts 9 (AnchorArchives → `rent_to`), 10 (DefenceClaims → beneficiary) | authority | to those recipients |

`frontier-operator end-season` does all of it in that order, in the setup's style: a **dry run by default** that reads
the cluster and lists every transaction, every account it closes with its lamports now and who gets them, and the
totals (fees; back to the authority; to others); `--yes-send` sends what is due, one transaction at a time, re-reading
the chain before each (**idempotent**: run the same line again to resume; a finished season prints
`end-season complete: nothing to send`); before the end bell (or before `end + 72 h`) it **refuses** with exit 3 and
sends nothing. On devnet a send needs the same gate as the setup: `--i-have-r0ze-approval --approved-sha256 $H` and the
key file of the Season's authority (another key: refused, exit 2); a profile whose `seasonId` / `programId` has no
Season on the cluster is refused too (exit 2), and so is a mainnet / testnet genesis or an RPC host outside the
profile's `allowedRpcHosts` (verify-pr180: `stack/tests/operator.rs` O4; interrupted runs — `--max-txs`, a SIGKILL
between two transactions — resume with no double close, PEND). Build it with the playable-lane feature (without it the wide provinces are not
listed and the final part stays BLOCKED).

```sh
# [r0ze] same build and key as §6b
B=frontier-node/target/release/frontier-operator; P=scripts/devnet/devnet-playable-profile.json; K=~/wylls-devnet-keys/authority.json
# any time: the plan (key-free without --authority; read-only RPC)
$B end-season --profile $P --rpc $RPC
# 1. at or after bell 1,008 [r0ze approves]: EndSeason (5,000 lamports)
$B end-season --profile $P --rpc $RPC --authority $K --yes-send --i-have-r0ze-approval --approved-sha256 $H --record end-record.jsonl
#    → "landed EndSeason"; exit 3 "CloseProvince x6 is not due before chain clock <end + 72 h>"
# 2. inside the 72 h: leave keeper A running (it drains: the last bells, transits, defence claims, its floats);
#    run the final verifier now (§8 step 9) while the witness RPC still serves the whole season (W1)
# 3. at or after end + 72 h [r0ze approves]: the dry run first (check "found N legacy + M wide provinces (funds count N+M
#    opened)" and no BLOCKED line). If it prints a WARNING line, keeper A still holds floats: BellAnchors not archived yet
#    NEVER close after the final part (ArchiveAnchors needs Running / Ended), and keeper A stops every duty on the
#    tombstone, so its ArrivalSlot / ArrivalDay / ClashInputs / SeedCache floats would have no sender after it (they stay
#    closable by anyone, by hand). Leave keeper A running (close + archive roles; from end + 72 h every march record may
#    close) and re-run the dry run until those lines are gone or stop shrinking (verify-pr180). Then the same send line →
#    every close; exit 0 "end-season complete: K transaction(s) sent"
# 4. keeper A logs "season-closed" and stops every duty by itself; stop it, keeper B, the gateway; the herald keeps
#    serving the ended season (/h/season "statusName": "Closed", the page shows 閉鎖 / 受付終了) — the herald of §8 step 1,
#    built with land-preview,wide-world-experimental,expedition-records-experimental: a plain `cargo build -p herald`
#    refuses every PSW1 record (UnsupportedWideRecord, "ingest store failed; reopen required") and stops at the first
#    wide record, at the latest at the first WideClose(6) here (D-end-2; CI's PEND runs that plain build and asserts either)
# 5. keeper A's and the relay's leftover SOL back to the operator (PLAYTEST-RUNBOOK §3 step 15), then, to end the test:
#    solana program close <PROGRAM_ID> ... (§5)
```

**Expected refunds** (offline PEND, `stack/tests/operator_playable.rs`; the devnet figures are the dry run's on the
day — it prints them exactly): the authority gets back what the setup put in and the season did not spend — the
creation bond (1 SOL), the Season's rent above the tombstone, the Frontier, the JoinShards and BeaconLogs, the six
funds (36 SOL less nothing: every province's rent comes back into its fund before the final part) and the DefencePool
(20 SOL less the defence pay already claimed). Keeper A gets the RingSeeds' rent. Measured offline (PEND, 79 legacy + 108 wide provinces,
rent 5,080): EndSeason 3,460 CU / 5,000 lamports; then 50 transactions (CloseProvince × 6 per tx ≈ 31,700 CU, WideClose(6)
× 4 per tx ≈ 27,000 CU, CloseSeason parts 17,900–37,500 CU), fees 250,000 lamports, **57,137,200,640 lamports back to the
authority** (the setup had spent 57,139,689,040), every recipient's lamports equal to the dry run's line to the lamport. **Not returned by this tool**: the
players' Citizens and Holdings (CloseCitizen / CloseHolding, anyone, rent to the players; still possible on the
tombstone), keeper A's ArrivalSlot / ArrivalDay / ClashInputs / SeedCache floats (its `close` / `archive` roles; also
closable on the tombstone), and the **wide ring seeds** (keeper A's 1,625,600 lamports each at 5,080, 2,227,200 at
6,960): the program has no close for them (D-end-1), so every devnet season strands the three of `wide_rings` = 3 for
good: **4,876,800 lamports (0.0049 SOL) at 5,080, 6,681,600 (0.0067 SOL) at 6,960** (§6 operator cost table; a
program change, blocked on r0ze).

## 7. Services and play (not ready: never run on devnet)

Re-checked against the code on 2026-11-22 (`origin/main` 6912906d; before: 2026-11-21, 436bb9c1). "Done (code)" and "closed (code)" mean merged
and proven **offline only**: the §1a `.so` in an in-process local chain on loopback, with the real keeper, herald,
gateway and page. **No season, no keeper and no send path has ever run against a real cluster.** §7.0 is the short
list; the table after it keeps each item's detail.

### 7.0 Done and open (2026-11-22; rows for #147–#180 added 2026-11-23)

**Done (code), with the PR that closed it:**

| # | What | PR | Offline proof |
|---|---|---|---|
| G1, G2, G5 | Rust services over `https`; keeper `feed = "rpc"`; payer listing | #44 | loopback; the read path also ran read-only against the real devnet RPC on 2026-11-21 (#123: fclient over real TLS, the keeper's cluster feed, 1,568 read requests, nothing sent) |
| G4 (B3), K1 | `frontier-operator --preset S1_DEVNET_WIDE_7D` (10 transactions); the lane's 64 MiB loaded-data budgets | #101 | `operator_playable` P1–P3 |
| P2 (Q-W1) | Rim first villages: preset `outpost_tier_min` 0, keeper `rim_per_wedge`, `tickets` role | #104 | P4 |
| P16 | Provinces on demand: keeper A's rings duty `provinces_reach` opens the provinces next to the settled land, so a nation can found second villages past the genesis rings (D-devnet-rim-homes-2) | #138 | PPROV |
| P6, P7 | Keeper A opens the wide rings 129–131 and settles / finalizes wide claims (`wide-tickets`) | #107 | P5 |
| P8 | Keeper A's feed guard accounts for wide-land records (PSW1 kinds 1–17) instead of latching | #108 | P6 |
| P1 | The page on devnet, wallet-paid: Join, PlaceHome / rim FileTicket, Harvest, Build, Train, Muster, WideClaimSite | #110 | P7 (browser) |
| P12 | The legacy war: the page's sealed Depart; keeper A's play roles reveal, clash and settle | #118 | P8, P9 (browser) |
| P12 | The return march home; the card waits through a lagging read; self-reveal backup through a keeper outage | #122 | P10 (browser) |
| P12 | A held keep is resolved every bell (contested follow-up): taken after exactly 72 held bells | #120 | verify-pr120 by hand; automated since devnet-72bell-pair: PCAP |
| P12-cap, P12-pair | The page's keep march held through 72 bells to the capture (chain, herald, page guide; keeper A's lag per bell) and an out-and-back march pair (OUT on the page's card and the real T(21), HOME the wallet's TEST-sealed Depart after the stamina rest) | devnet-72bell-pair | PCAP ×2, PPAIR (browser; §7.0b) |
| P13, P10 | Keeper A's `expeditions` role (every step after the player's ExpeditionDepart); the guard reads the expedition's records | #121 | P11 |
| B5 | Read-only RPC client: bounded, jittered 429 backoff honouring `Retry-After`; version-1 transactions no longer stall ingest; `getProgramAccounts` filtered by season | #123 | recorded devnet answers in CI |
| P5 | Fog of war on the devnet page (player view, `DEVNET_FOG`; cosmetic: herald, spectator page and chain stay public); P9's page driver presses the #122 `march-send-wait` button | #127 | PFOG (browser, three players) |
| P15, P9 | The page's devnet ExpeditionDepart, wallet-paid; keeper A's `wide-resolve` role keeps the known wide provinces resolved bell by bell | #129 | P12 (browser) |
| P14 (a) | Keeper A reads every conquest record exactly instead of latching (defence in depth since (b)) | #124 | `operator_playable` P14 on the previous `.so` `da3dc1aa…` (key-tests only) |
| P16b | The page's second / third village: one wallet-signed FileOutpost (0.00716 SOL), settled by keeper A's `tickets` role | #141 | PPOST (browser) |
| S1 (H-1, H-2, M-2) | The public endpoint: the gateway refuses to start off localnet without `--public-proxy xff\|none` (or `--dev`); per-address and global caps on `/gw/f/reveal` and `/gw/f/nudge`; keeper A refuses forged reveals and far-future nudges before any RPC; the herald reads the last `X-Forwarded-For` entry, caps `WS /h/ws` at 64 per client and checks `Host` / `Origin` | #164, #166 (checklist #165, §8a) | PGWF flood runs (verify-pr166); the §8a 15-nudge check through a TLS stand-in proxy (devnet-dress-rehearsal) |
| F1 | Rent at the cluster's rate: keeper A's fund floor, opens and crowding check read the Rent sysvar (`/v1/status` `duties.rent`); the page's escrow previews and the verifier's VX / VG follow it | #147, #150 | verify-pr147, verify-pr150 (PPOST at 5,080 and 6,960) |
| P17 | The wide village's own acts on the devnet page: WideHarvest, WideBuild, WideTrain, WideMuster, wallet-paid | #151 | P17 (browser); devnet-dress-rehearsal run6 |
| P1b | The page waits up to 180 s for the herald to show its own Join / village request (`fown-wait.mjs`), then offers 「もう一度確かめる」 | #172 | P7 behind a 30 / 60 / 150 s delaying proxy (verify-pr172) |
| V1 | The verifier decodes and re-executes v0 / v1 transactions, snapshots lookup tables at first use, and V7 / V11 (every `World::state_before` reader) read declared patches | #155, #158, #169, #179 | 97 archives re-judged (verify-pr179): only the dress rehearsal's season changed, FAIL → UNVERIFIABLE |
| E1 | The season's end: `frontier-operator end-season` (EndSeason, then from end + 72 h every province close and CloseSeason part; §6c) | #180 | PEND ×5 (verify-pr180): 57,136,950,640 lamports net back to the authority = the dry run's `authority_net`; resumes after `--max-txs` and a SIGKILL |
| D1 | The whole of §8 / §8a rehearsed offline in order (operator, keeper A from the §8 `keeper.toml`, herald behind a TLS stand-in proxy, gateway `--public-proxy xff`, 5 wallet-paid pages + 2 external residents, to bell 1,012); its runbook fixes | #177 | devnet-dress-rehearsal run4, run6 |
| P14 (b) | Free City conquest closed in the devnet build (owner decision 2026-11-22: P14 = (a) + (b)): no `conquest-dispatch-experimental`, the wrapper's kinds 12–18 answer `BadData` before any account is read, so no conquest record can latch keeper A's feed guard; new `.so` `67a33c92…` | #139 | `verify/tests/p14b_devnet_no_conquest.rs` (every recorded kind 12–18 transaction re-executed on the new `.so`: refused, no record, keeper A's indexes not latched), `svm-tests/tests/devnet_playable.rs` (the fresh build) |

**Open:**

| # | What is missing | Whose | State |
|---|---|---|---|
| P14 | Nothing left to decide. **The deploy confirmation is for the new `.so`** `67a33c92…06b3` (§1a; `da3dc1aa…b9741` must not be approved any more). Rebuilt twice by verify-pr139 on the merged tree with the same hash; nothing the build links changed after #139 (#137, merged after it, touches the page, the launcher and the local chain only) | **r0ze** (the "deploy OK" only) | (a) #124 and (b) #139 merged |
| P11 (O11) | Who pays a player's fees and rent. Today the player's wallet (about 0.02 SOL, §4b) | **r0ze** (not blocking) | wallet-paid is implemented; sponsoring is not wired |
| Q-W3 | `outpost_tier_min` 0 lets every Hamlet file an outpost, in the heartland too (as local wide play) | **r0ze** (not blocking) | implemented as 0; reverting is one preset byte, the `.so` is unaffected |
| W1 | **The verifier's witness endpoint.** A PASS on a public-RPC season needs a second, independent RPC that serves the whole season. The only free no-sign-up second provider found (OnFinality) keeps about 7 days of history; a season is 7 days + the 24 h lead + about 21 h of map growth, so after the season ends such a witness reads UNVERIFIABLE (fail-safe, never PASS). Choices: an archival provider (sign-up), an own node, Old Faithful, or verifying while the season is still inside the witness's window | **r0ze** | measured read-only on 2026-11-21 (devnet-readonly-rpc) |
| H1 (B11) | **Hosting and an RPC provider.** A host for keeper A, the herald and the gateway behind a TLS reverse proxy with a public name (what the proxy must set and which ports stay closed: §8a). The public `api.devnet.solana.com` allows about 10 calls of one method per 10 s per IP (HTTP 429, `Retry-After: 10`); the herald alone makes about 2 calls a second idle with the §8 step 6 flags (`--rpc-min-gap-ms 100 --poll-ms 1000`: 1.8/s measured; ≈ 160 k calls/day, ≈ 4.8 M per 30 days, + about 2 per program transaction) — and about 4/s, idle or busy, with the old gap 250 and the default poll 200 (≈ 340 k/day, ≈ 10 M per 30 days; herald-load-50, fix-devnet-join-wait) —, each method above the public limit, so a season needs a provider endpoint | **r0ze** (sign-ups) | not needed for the deploy itself |
| P12-cap | ~~The keep's capture on devnet's clock~~ **closed offline by devnet-72bell-pair (PCAP)**: the page's sealed march onto a neighbour's keep (its card, its wallet, its time-lock to the real T(21)), keeper A with the devnet profile's roles (`archive` included) and rings duty (`rim_per_wedge`, `provinces_reach` #138; live Rent sysvar #147; not `wide_rings`, which offline can only bind a shipped round), the preset's real 600 s bells with the chain clock at ×40: taken after exactly 72 held bells (contest from bell 21, `keep_taken` at bell 92, `since_bell` 93), the herald's `/h/keep` history and `/h/conquest/0.json` event, the page's guide 「第92ターンに、あなたの国（…）が州 -128,67 を奪いました」, the donor's return (reserve 0 → 191 at bell 106); keeper A's lag per held bell at ×40 under load 57–154: median 7, p90 10, max 11 bells (71 bells in 1,196 s of wall time, ~16.8 s per bell, i.e. about 3 % of a real 600 s bell). Verifier over the archive (#155): 0 FAIL, UNVERIFIABLE only from the declared beacon (R1). Browser test, not in CI (local recipe §7.0b) | engineering | closed offline; the real-clock run is the first devnet season |
| P12-pair | ~~The second leg of an out-and-back pair~~ **closed offline by devnet-72bell-pair (PPAIR), one leg declared**: OUT = the page's own march card to the neighbour's tile on the real T(21) (keeper A anchors, opens, reveals, gathers, resolves, settles; the herald shows the host abroad); HOME = the same wallet's Depart at bell 48 — the first bell the host may leave again: a sealed Depart charges 74 stamina whatever its path (cap 120, +1 a bell, so ~28 bells' rest; the old line's plan of a return right after the arrival cannot exist) — sealed to the TEST beacon key over a declared TEST-signed anchor (offline only one bell a season can have a real round: PR CI `pkf_offline_a_season_has_at_most_one_real_arrival_round`), revealed by the wallet, settled by keeper A at the village tile (bell 51 arrival, settled by bell 54); the herald's records of both provinces agree with the chain. Verifier (#155): 0 FAIL, UNVERIFIABLE only from the declared beacon. What stays unproven offline: keeper A opening a SECOND real seal in one season (R1) | engineering | closed offline (one real leg); both legs real only on devnet |
| P4 | Operator AI residents and the test-token faucet are localnet-only | engineering | open |
| P4b | ⑬ / ⑤B EXTERNAL AI residents have no devnet path as shipped: the ⑬ client (`workstreams/13-citizens/resident/local/client.mjs`) knows only the launcher and its sponsored local relay, and the external-resident helpers (`03-composability/mcp/examples/external-resident/public.mjs` `getJson`) refuse any herald that is not plain-http loopback, so a TLS-fronted devnet herald is unreachable. devnet-dress-rehearsal ran two ⑬ residents offline through a TEST adapter (⑬'s own brain/journal/runner, the page's `submitLocalAct` with `devnetLane`, its own key as wallet, plain http to the proxy): Join, PlaceHome, about 70 Builds, 160 Harvests and 88 Trains landed wallet-paid over a whole season | engineering | open (D-dress-5) |
| P3 | Wide → wide marches (and so a wide keep's capture) answer `NotImplemented` in the devnet build | by design (Q-W2) | closed gate |
| R1 | Real drand rounds: every bell's anchor and seed, and the 125 bells of map growth to ring 128, were **declared patches** offline (the workspace ships 32 real quicknet rounds). On devnet keeper A posts each from the live round | engineering | first exercised by the first devnet season |
| R2 | ~~The herald does not decode version-0 / version-1 transactions~~ **closed by herald-v0v1-decode**: `fclient::vtx` decodes legacy, v0 (with `meta.loadedAddresses`, carried on every `TxRecord` and archived) and v1 (SIMD-0385) wires; findex `Enriched` fetches a v0 transaction's looked-up writable accounts, so the herald folds them; keeper A's expedition evidence reads v0/v1 Departs/Reveals; the localnet takes, executes, keeps and serves v0 (lookup tables through the real program; SlotHashes now kept) and v1 (offline proof PV0 on the devnet `.so`: a wallet's v1 Join and web3.js v0 PlaceHome through its own table, the herald shows the home, `badRecords` 0). The alarm stays for a wire that decodes as none of them or a v0 one without its loaded addresses. **The verifier (verifier-v0v1)** reads legacy / v0 / v1 too (`verify/src/vmsg.rs`): every check reads a v0 transaction's accounts through the archived `loadedAddresses`, and the new check **VT** (`verify/src/lookup.rs`) checks each of them against the lookup table account read at the pinned slot with the final states (`--rpc`; a finals file or fixture records `lookup_tables`): a difference FAILs (`LookupMismatch`), an unread or closed table is UNVERIFIABLE (`LookupTableUnread`), never PASS — unless (verifier-alt-archive) a **snapshot** settles it: findex archives each table's account, read slot and own create / extend transactions with the first record that uses it (frame key `tables`), and `--rpc` reads a closed table's own transactions itself; a snapshot that contradicts the record FAILs, one that cannot be proven is UNVERIFIABLE (`LookupSnapshotUnproven`), a table read before the transaction is UNVERIFIABLE (`LookupTableStale`), and VS has every witness compare the table bodies and confirm each lookup on its own reads (an account-only snapshot of a closed table cannot be witnessed); VX/VG re-execute v0/v1 as signed (LiteSVM resolves the lookups against tables holding exactly those addresses). A wire of an unknown version, non-canonical or with missing loaded addresses still FAILs `Undecodable`. Offline proof: `verify/tests/versioned_season.rs` (devnet `.so` 67a33c92, v0 OpenProvince/PlaceHome/Harvest, v1 Join/Build/FoldLand: PASS with post-states and by genesis replay; the CLI over a live node, port 41850). **Still legacy-only:** keeper `wideproof` (local-test wide → wide only). Open: the keeper's and herald's default 150 ms RPC gap is tighter than the public endpoint's limit | engineering | v0/v1 decode closed (readers and verifier); #123's D-6, D-7 open |
| R3 | SIMD-0500 (inactive on 2026-11-18) would refuse a deploy or upgrade of this SBPF v2 `.so` once active (§3) | risk | re-check right before the deploy |
| P17 | **The wide village's own acts on the devnet page** (devnet-p17). The page's wide village screen has the card 「この遠方の村への命令」 on a devnet season: WideHarvest, WideBuild (items 0–7; walls and the tier-up name the province writable), WideTrain and WideMuster (0xDA op 3 / op 1), each two presses — the SOL preview (the fee; on the province's FIRST muster also the rent of its 3,248-byte wide roster, the gateway's `getMinimumBalanceForRentExemption`) and ONE wallet-signed send through `/gw/f/devnet-play/act/submit` (`DEVNET_ACT_COMMANDS`; the gateway reads the wide holding — this program's, this Season's, the wallet Citizen's — and its province before the send) — then the result read back from the village's next record. WideGarrison and WideDepart are not offered (WideDepart stays `NotImplemented` in the devnet build). Before this, only local play sent WideTrain/WideMuster/WideDepart (`flocalplay-wide-host.mjs`, the TEST host card); nothing sent a wide Harvest, Build or Garrison from a page. WideMuster still needs the province resolved to the previous bell (keeper A's `wide-resolve`, P9); offline proof P17 (operator_playable, `DEVNET_PAGE_DRIVER=1`) declares that cursor as P6 does | engineering | **closed by devnet-p17** (draft PR); the devnet `.so` 67a33c92 unchanged |
| C1 | Keeper A's fees outside §4a's total: `wide-resolve` (64,331 lamports a bell and known wide province; its 600,000 CU limit is about 7× a quiet Resolve's 84,000 CU, so a lower limit would cut the fee to about a quarter, a behaviour change proposed by verify-pr129, not made) and SkipQuiet over provinces opened on demand (#138) | engineering (optional) | §4b; budget +3 to +10 SOL |
| F1 | Keeper A's on-demand fund floor is compiled for 5,080 lamports per byte (`RENT_PER_BYTE`; `rings.rs` `demand_fund_floor`), the program charges the cluster's Rent sysvar: at another rate the floor is wrong (§6; at 6,960 too low, so on-demand opens could starve OpenRing and the wide rings) | engineering | **closed by keeper-rent-floor (#147)**: keeper A reads the Rent sysvar for the floor, each open's rent and the crowding OpenRing check; rate unknown or > 1 h stale → no on-demand opens / crowding rings + `rent-unknown` alert (offline proof PFLOOR at 5,080 and 6,960). The page's and the verifier's leftovers closed by rent-live-rest: the page's village-ticket escrow preview reads the cluster's rent through its gateway route (`web/frontier/frent.mjs`, cached 10 min, labelled 「目安」 with the 5,080 model until a cluster answers; the FileOutpost and boundary-departure previews already asked the cluster per send), and `frontier-verify` re-executes (VX / VG) under the Rent sysvar it reads with the final states over `--rpc`, a finals file's or fixture's `rent`, or `--lamports-per-byte`; with none it assumes 5,080 and its report says `assumed` (offline proofs: PPOST at 5,080 and 6,960, preview = debit; `verify/tests/playable_rent.rs`). Still at 5,080: the sponsored relay's drain-guard allowances (`gateway/src/frontier/shapes.mjs`, local / sponsored only: the devnet path is wallet-paid) |
| T1 | CI coverage: P14 (conquest reader) runs on the previous `.so` and in the manual key-tests only; P8's `AFTER_BELLS` is still 48 (< 72, so no capture in CI) — the capture is proven by PCAP and the pair by PPAIR, both browser runs (~40 / ~35 min each, skipped in CI like P7/P9/P10: no browser there, and longer than the key-tests budget); their key-free parts (`pkf_`: one real arrival round per offline season, the lag report, PPAIR's OUT tile) run in PR CI; the P12/PPOST/P7 page drivers race the declared map growth under load (D-devnet-page-outpost-3, D-verify-pr139-5; P9's driver now reloads until the page offers a rim home) | engineering | open |

### 7.0b Local recipes: PCAP (72-bell capture) and PPAIR (out-and-back pair)

Browser runs (node + headless Chromium), offline, on the devnet `.so` `67a33c92…`; never run `operator_playable`
unfiltered. From `frontier-node/`, after `npm ci` in `permutation-gateway` and `permutation-gateway/screens`:

```sh
cargo build --locked -p keeper --features playable-lane --bin frontier-keeper
cargo build --locked -p drand-replay --bin drand-replay
cargo build --locked -p herald --features wide-world-experimental,expedition-records-experimental --bin frontier-herald
# copy the three bins aside (a later `cargo test -p keeper` overwrites target/debug/frontier-keeper)
export DEVNET_PAGE_DRIVER=1 FRONTIER_KEEPER_BIN=… DRAND_REPLAY_BIN=… FRONTIER_HERALD_BIN=… OPERATOR_EVIDENCE_DIR=…
OPERATOR_PAGE_CAPTURE_PORT_BASE=41500 cargo test --locked -p stack --features playable-lane --test operator_playable pcap_ -- --nocapture
OPERATOR_PAGE_PAIR_PORT_BASE=41520 cargo test --locked -p stack --features playable-lane --test operator_playable ppair_ -- --nocapture
```

- PCAP (~40 min at load 60–150): `OPERATOR_PCAP_HOLD_SCALE` (default 40) and `OPERATOR_PCAP_AFTER_BELLS` (default 110)
  set the hold's clock and window; `pcap-summary.json` → `rim.keeper_war.keeper_lag` has keeper A's lag for every held
  bell, `rim.capture` the chain / herald / page evidence, `pcap-season.json.gz` the season for `frontier-verify --fixture`.
- PPAIR: OUT is the page's own march card to the neighbour's first non-keep tile, time-locked to the real T(21)
  (keeper A anchors, opens, reveals, settles). HOME cannot also be real offline: only ONE bell of a season can have a
  real quicknet round (PR CI test `pkf_offline_a_season_has_at_most_one_real_arrival_round`), and a host may leave again
  only ~28 bells after a sealed Depart (74 stamina whatever the path, cap 120, +1 a bell). So HOME is the same wallet's
  Depart at the first bell its stamina allows, sealed to the TEST beacon key over a declared TEST-signed anchor and
  revealed by the wallet; keeper A settles it. On devnet both legs are ordinary sealed marches keeper A opens from the
  live rounds (and the page's 「村へ戻す」 card sends the HOME leg; P10 proves that card offline). The stamina rest is a
  rule of the program (`permutation-rules` host stamina, `proc/host.rs` DEPART_STAMINA), not of the offline proof: on
  devnet too a host leaves again only ~28 bells after its last sealed Depart (about 4 h 40 min of 600 s bells).
- Verifier over either archive: the playable-lane build (without the feature it reads `UnknownProgramVersion` 0x4804):
  `cargo build --locked -p verify --features playable-lane --bin frontier-verify`, then
  `frontier-verify --fixture <run>/pcap-season.json.gz --program-so fixtures/verify/devnet-playable-67a33c92.so.gz --json`
  (or `ppair-season.json.gz`). Expected: verdict UNVERIFIABLE (exit 2), 0 FAIL; every finding is `MissingData` from the
  declared beacon (R1: V0E, V4, V7, V11, V15, VX; PPAIR also V5 for the TEST-sealed HOME leg) plus WARN V9.
  (devnet-dress-rehearsal D-dress-7: V7 does not read declared states — only V11 does since #169 — so a declared Holding
  patch (the 400 spearmen) followed by the page's own Harvest before its Muster reads `HoldingReplayMismatch` FAIL on an
  honest archive; PCAP/PPAIR declare the troops right before the Muster and do not hit it. Offline-only.)

A playable first season does not need any open engineering item above: Join, the rim village, second and third
villages (FileOutpost, #141, on the provinces #138 opens), the economy, the wide claim, the legacy war and the
rim → wide expedition (the page sends its Depart since #129) are all served, with fog on the page (#127). A wide
village, once claimed and finalized, is held but not used from the devnet page (P17). **DECIDE NOW: nothing** (P14 was decided 2026-11-22 01:12 JST and both halves
are merged). What r0ze still has to do is the deploy-day list below; W1 matters only for a verifier PASS / the prize.

**MUST at deploy time, r0ze, in order:**

1. Play-check locally (t341u): `scripts/play-local.sh`, then `--wide`.
2. Approve one read-only devnet re-check right before (§3: rent rate, BLS, SBPF v2, SIMD-0500). If the rent rate is
   not 5,080: re-run the planner at the measured rate (`scripts/devnet/dry-run.mjs … --rate <rate>`) and fund the
   deployer, authority and keeper A from its totals (§4); keeper A's fund floor follows the rate by itself (F1 closed),
   but at a higher rate far fewer provinces open on demand (§6: about 23 at 6,960); the page's SOL previews and the
   verifier's re-execution follow the cluster's rent too (F1 row, rent-live-rest) — r0ze decides go / no-go.
   After keeper A starts, check `GET /v1/status` `duties.rent`: `lamports_per_byte` = the measured rate and
   `usable` true (and no `rent-unknown` alert).
3. Install a Solana CLI ≥ 4.0.0 beside 3.1.9 (3.1.9 cannot deploy this `.so`; §1a).
4. Make 3 keys offline (deployer, program-playable, authority; never `--final`); put the 2 public keys into
   `scripts/devnet/devnet-playable-profile.json` (`programId`, `upgradeAuthority`).
5. Faucet (5 SOL a request): 5 requests for the deploy (7 at 6,960); about 25 (28) with one season; +1–2 for keeper A's
   fee budget (§4b).
6. Rebuild (`scripts/build-frontier-devnet-playable-sbf.sh --twice`) and say "deploy OK" in chat for exactly the hash
   it prints (today `67a33c92…06b3`) → §8 step 3.
7. Before the season: sign up for an RPC provider and a host with a public name and TLS (H1, B11).
8. Only for a verifier PASS / the prize: pick an archival witness RPC (W1).

### 7.1 Detail

| # | Gap | Status | Evidence |
|---|---|---|---|
| G1 | The Rust services POST JSON-RPC over `https` | closed (code): hardened `curl`, no TLS crate | `frontier-node/crates/fclient/src/https.rs`, `http.rs` `post_json_with` |
| G2 | The keeper reads the program feed from a public RPC | closed (code): `keeper.toml` `feed = "rpc"` (default stays `"localnet"`) | `keeper/src/clusterfeed.rs`, `keeper/src/config.rs` |
| G4 | Operator tool for AnnounceSeason, CreateSeason, InitBeaconLogs, InitShards (and the lane's WideSetRules) | S1 presets: closed (§6). Playable lane: closed (code), `--preset S1_DEVNET_WIDE_7D` (§6b). Both local tests only | `stack/src/operator.rs` |
| K1 | The keeper's transactions fit the lane's program (loaded data) | closed (code): a 0x4804 season takes `Budgets::canonical_lane` (64 MiB); loopback test only | `fclient/src/budgets.rs`, `stack/tests/operator_playable.rs` |
| G5 | Address listing for keeper and relay payers | closed | `frontier-keeper --print-addresses`, `--print-relay-addresses` |
| P1 | **The playable lane's page actions on devnet.** First village, economy and wide claim: closed (code), loopback test only (devnet-page-path). On a devnet season whose gateway runs with `--devnet-play` (cluster devnet, `--rpc` an https URL the operator names, `--devnet-play-ruleset-hash`), the page sends Join, PlaceHome, the rim FileTicket, Harvest, Build, Train, Muster and WideClaimSite itself: the player's connected wallet (`solana:devnet`) signs once and is fee payer AND actor, so it **pays its own fees and rent** (Join 2.61 M, rim FileTicket 7.16 M, wide claim 9.11 M lamports); the gateway's `/f/devnet-play/act/*` rebuilds each command for the transaction's one signer and forwards it once, and sponsors nothing. The Join registers the wallet as its own session key (no in-game key). A wide devnet season (`rMaxCeiling` 128, opened past ring 128) offers opened rim provinces of the player's nation as first villages. The herald must be built with `--features wide-world-experimental,expedition-records-experimental` (`play-local.sh` builds it with these and `land-preview`; §8 builds all three): the default build answers `503 WideWorldUnavailable` on `/h/world/wide`, so the page has no wide provinces to claim. The LEGACY war (P12 below) is served too: the page's sealed Depart. Keeper A now drives a rim → wide expedition after its Depart (P13, P10 closed in code); the page sends the devnet ExpeditionDepart itself since #129 (P15). Second and third villages (FileOutpost) since devnet-page-outpost: the village screen's 「2つめ・3つめの村を出す」 card (`screens/outpostcard.mjs`) lists the provinces past the heartland within `outpost_range` of the first home, says of an absent one that it is not opened yet, shows the wallet's cost in SOL (one Holding rent escrowed, 7,152,640 lamports on localnet's rent, + the 5,000 fee) on a first press and sends ONE wallet-signed FileOutpost on the second; the gateway lists it in its info (`outpost`), reads the anchor home and the target Province (absent: `LocalActProvinceAbsent`, nothing sent), and keeper A's `tickets` role settles it (PPOST test). Still localnet-only: Free City conquest (P14), and the wide village's host acts (WideTrain/WideMuster/WideDepart; P3) | closed (code) for the first village → wide claim, the legacy war and the expedition's Depart (P15) | `permutation-server/web/frontier/fdevnetplay.mjs`, `flocalplay-act.mjs` `devnetLane`, `permutation-gateway/src/frontier/devnet-play-act.mjs`, `stack/tests/operator_playable.rs` P7 |
| P12 | **The legacy war on devnet (devnet-page-war).** Muster, ONE sealed Depart (onto a keep, a village or home: the return is a Depart to the home tile), the reveal, the clash, SettleTransit, a contested keep's bells, the capture and the donor's return. The page sends Muster and the Depart itself, wallet-paid (`POST /f/devnet-play/march/submit` + `/status`: local play's march validator, the Depart rebuilt for the ONE signer and the Season's id, the seal's shape, the host of THIS village, one read of Citizen, village and province, the replay barrier, ONE send); the seal is the page's own time-lock to T(arrive). Everything after the Depart is **keeper A's play roles** — `reveal`, `settle-departure`, `gather`, `resolve`, `skip`, `settle`, `close`, `claims` (`keeper/src/play.rs`, the S1 playtest keeper A's roles), now in the devnet profile: it anchors T(arrive) from the live round, opens every sealed march from that public round (anyone can, once the round is out) and reveals it before `A + W − 2` slots, gathers, resolves, settles. The page keeps the reveal half in an ENCRYPTED march book (`fdevnetbook.mjs`: IndexedDB, a non-extractable AES-GCM key, survives a reload) and hands it to keeper A (`POST /gw/f/reveal` → `/v1/reveal`, the gateway needs `--keeper` and `--keeper-token-file`) only once T(arrive) is published. Offline proof: `operator_playable` P8 (a test participant) and P9 (the page; `DEVNET_PAGE_DRIVER=1`), ports 41950+ / 41960+, genesis round 32,551,749 so that T(21) is a real round. **devnet-page-war-2 (P10, `DEVNET_PAGE_DRIVER=1`, ports 41575+):** the page's RETURN march — a Depart to its own village's tile (「村へ戻す」) arriving at the real-round bell 21 — settles at home (SettleTransit over keeper A's REAL anchor); keeper A stopped at the Depart bell: the march card no longer stands disabled while the page's read of the home province lags (NotResident) — one press arms ONE waiting send (`controller.mjs` `marchWaitOn`, the herald re-read at most every 5 s), sent once, wallet-signed then, when the read catches up; keeper A stopped across T(21) with drand-replay back WITHOUT T(21): the page's self-reveal backup (`/gw/f/reveal` → `/v1/reveal`) is refused (KeeperUnavailable), asked again every 60 s (`marchbook.mjs`: attempts that never reached a keeper do not count, at most 10 posts), accepted, and the Reveal lands inside the window once T(21) is served. Keeper A sends a Reveal (also one built from owner material) only after THE anchor exists AND it holds T(arrive)'s signature itself (`play.rs` ⑱), so on chain the page's material changes nothing for a keeper that can open the seal; it matters for a keeper that never saw the Depart's seal. **The keep's CAPTURE** (72 held bells, `Keep.required`): #118's run stood at 9/72 because keeper A sent one contested write per tick; #120's contested follow-up sends the gather and the resolve of a held keep in the same tick, and verify-pr120 then saw the keep taken after exactly 72 held bells and the host's return settled — with `AFTER_BELLS` raised from 48 to 110 by hand (the committed window of 48 bells is shorter than 72, so CI's P8 never shows a capture). **Still not reached offline:** an OUT-AND-BACK pair of marches (a march home FROM a keep): only ONE bell (21) has a real T(b) offline, and SettleTransit opens the seal with THE anchor's BLS signature (`proc/transit.rs` step 4, I-44) — over a DECLARED anchor (no real signature) it is refused (BAD_POINT), so the second march of a pair can never settle offline; on devnet every anchor is keeper A's real one | closed (code), loopback only, through the clash and SettleTransit (P9) and the return home through two keeper outages (P10, re-run by verify-pr122); the keep's capture and the return after it once, by hand (verify-pr120; not in CI). **NOT READY, open:** (1) the capture on devnet's clock (72 bells = 12 h; §7.0 P12-cap), (2) the second leg of an out-and-back pair (a march from a keep back to the village), which needs real drand rounds for several bells, i.e. a devnet run or more real-round fixtures | `permutation-gateway/src/frontier/devnet-play-act.mjs` `marchSubmit`, `permutation-server/web/frontier/flocalplay-march.mjs` `devnetMarchLane`, `fdevnetbook.mjs`, `stack/tests/operator_playable/war.rs` |
| P13 | **The rim → wide expedition's own steps (devnet-expedition-keeper).** After the player's ExpeditionDepart (0x4804 wrapper, kind 0; the only step the player pays) keeper A's new role **`expeditions`** (`--features playable-lane`; needs `beacon`, `gather`, `resolve`) sends every later step, permissionless, from its own pools: the origin's departure bell is handed to the play duty (its skip run stops before it; GatherClash with no arrivals and ResolveFromInputs, since the Depart's pending Spend makes it NotQuiet), **ExpeditionSettleOrigin**, the wide **ExpeditionReveal** opened from the PUBLIC round T(arrive) (never at or after `A + W − 2` slots of THE anchor; a seal that does not open, a closed window or four taken slots are given up, the settlement judges them), the destination's catch-up wide **Resolve**s bell by bell (≤ 1,008), **ExpeditionGather** in packet-sized batches, the arrival's **Resolve**, **SettleMember** once `close + 600 s` passed (fates Stays, Withdrew, Bounced, Retreated, Destroyed; the camp winner and the failure / forfeit / terminal settlements are not driven). Anchors and seeds stay the `beacon` role's. One copy of the instructions and checks: `keeper/src/expedition_steps.rs`, also the local runner's drivers. Every step is planned from fresh chain reads, keyed by its object (restarts re-plan what is due); a refused step stops that transit for the process. Offline proof: `operator_playable` P11 (ports 41500+) | closed (code), loopback only | `keeper/src/expeditions.rs`, `keeper/src/expedition_steps.rs`, `stack/tests/operator_playable/expedition.rs` |
| P15 | **The page's devnet ExpeditionDepart (devnet-p15-p9).** On a devnet wide season the page's 「境界への道を準備」 card (a rim village's resident host; the route check reads the herald's captures) sends the expedition's Depart itself, wallet-paid, in two presses: 「送る内容を確認」 seals to T(arrive), keeps the reveal half in the ENCRYPTED devnet book (`fdevnetbook.mjs`, non-extractable AES-GCM key in IndexedDB, as P12), builds the unsigned message (`fexpedition-depart-message.mjs`, byte-equal to the keyless Rust CLI's) on the gateway's blockhash and shows the transaction preview (payer, fee, tip, march fee, bond, total, arrival turn, destination, accounts, digest); 「ウォレットで署名して送る」 has the connected wallet sign that exact message and posts it once to `POST /f/devnet-play/expedition/submit` (the gateway rebuilds the canonical request and the message, byte-compares, verifies the one signature, reads the Citizen, home village and origin province, replay barrier, ONE send; `/status` as the march's). No CLI is spawned on devnet; the reveal half is never posted (keeper A's `expeditions` role reveals from the public round). Local play unchanged (its relay path). Offline proof: `operator_playable` P12 (`DEVNET_PAGE_DRIVER=1`, `page_expedition_driver.mjs`) | closed (code), loopback test only (devnet-p15-p9) | `permutation-server/web/frontier/fdevnet-depart.mjs`, `permutation-gateway/src/frontier/devnet-play-act.mjs` |
| P14 | **Free City conquest (dispatch kinds 12–18) is NOT reachable in the devnet build since P14 (b)** (owner decision 2026-11-22 01:12 JST: P14 = (a) + (b)). Before, `CONQUEST_LIFECYCLE_ENABLED = false` (`proc/wide.rs`) closed only the RAW conquest commands while `devnet-playable-sbf` included `conquest-dispatch-experimental`, so the version-2 wrapper (`proc/wide_expedition_dispatch.rs`) reached the conquest bodies on a 0x4804 Season (the committed recordings of `da3dc1aa…` land DeclareSiege, ResolveWithConquest, SettleCapture, SettleSiege, CloseConquest, CloseCaptureEscrow and SettleReservation), and their records (PSW1 18–24 with PS2 145, PSWR, PSWC) LATCHED keeper A's feed guard. Now `devnet-playable-sbf` = `expedition-dispatch-experimental` + `land-preview`; `lib.rs` refuses to compile it with `conquest-dispatch-experimental` (any target), and the SBF conquest guard admits only `localnet-conquest-sbf`. `expedition_dispatch_ix::Kind::from_byte` has no kinds 12–18 in this build, so the wrapper answers `BadData` (custom 1) before it reads an account: no record, no account written, and keeper A's indexes skip the failed transaction (cursor advanced, not latched). Proof: `verify/tests/p14b_devnet_no_conquest.rs` re-executes all 101 recorded kind 12–18 transactions on the new `.so` (12: 4, 13: 88, 14: 2, 15: 1, 16: 2, 17: 3, 18: 1), each refused `BadData` with no `Program data:` line and fed to `LandIndex` / `PlayIndex` unlatched, while the old `.so` still lands them (control) and every recorded expedition kind 0–11 lands on the new `.so` with the recorded account states; `svm-tests/tests/devnet_playable.rs` sends kinds 12–18 to the fresh build on a seeded 0x4804 season. The local land lane keeps the conquest kinds. **Option (a), MERGED (PR #124, devnet-guard-conquest):** a `playable-lane` keeper A READS every conquest record exactly instead of latching (`feedguard.rs` P14; anything unpaired, forged, truncated or foreign still latches), loopback-tested by `operator_playable` P14 on the previous devnet `.so` `da3dc1aa…` (which still lands the kinds); on the new devnet `.so` it stays as defence in depth. The keep of a legacy province is still taken by an ordinary march (P12) | closed (code); the new `.so` (`67a33c92…`) awaits r0ze's deploy confirmation | `permutation-frontier/Cargo.toml` `devnet-playable-sbf`, `src/lib.rs`, `verify/tests/p14b_devnet_no_conquest.rs` |
| P11 | Who pays a devnet player's fees and rent (O11): the devnet play routes are wallet-paid, so each player needs devnet SOL in their wallet (about 0.02 SOL for Join, rim request and one wide claim, plus fees). A relay-sponsored path (the gateway's pool, as `POST /f/relay` sponsors S1 shapes) is not wired for the lane's wide claim | open, **r0ze** (O11) | `devnet-play-act.mjs` header |
| P2 | First homes at the rim (owner decision Q-W1, 2026-11-20: allowed on wide devnet seasons, as in local play): PlaceHome is capped at the season's base `r_max` 16, so a rim home is a one-site FileTicket, settled by keeper A's `tickets` role, on the rim provinces its `rim_per_wedge` duty opens; `S1_DEVNET_WIDE_7D` has `outpost_tier_min` 0, so that Hamlet anchors a wide claim. The page offers it on a wide devnet season (P1, P7 test) | closed (code), loopback test only | `keeper/src/rings.rs` `rim_plan`, `stack/tests/operator_playable.rs` P4 |
| P3 | Wide → wide marches (WideDepart) answer `NotImplemented` in the devnet build by design (§1a), so a wide keep, which only such a march can reach, cannot be captured there; local TEST only (`localnet-wide-depart`) | closed gate | `proc/wide.rs` `DEPART_DEBIT_ENABLED` |
| P4 | Operator AI residents (`--agent-wallet`, `--agent-runner`) and the test-token faucet are localnet-only | open | `permutation-gateway/src/frontier/config.mjs` |
| P8 | **The keeper's feed guard stopped keeper A at the first wide record.** A successful transaction logging a `PSW1` record latched the fail-closed feed guard for good, after which only beacon writes went out (rings with P6's wide rings, fold, tickets and `wide-tickets` stopped); a wide village's own actions (WideEconomy Harvest/Build/Train, WideGarrison, WideMuster, WideDissolve) log one. A `playable-lane` keeper now **accounts for** (counts, never applies) a PSW1 record only when it decodes exactly, its kind is the wide march lifecycle or the wide holding's owner actions (kinds 1–17), and every province it names is of the season's world and wide (ring > 128). Everything else still latched at #108: undecodable or unknown records, the rim↔wide bridge kinds 25/26 (read exactly since #121, P10) and the conquest kinds 18–24 (read exactly since #124, P14 a; not producible by the devnet `.so` since #139), a legacy or foreign identity, the expedition PS2 kinds, and (new, every build) any other record format of the program (PSWC, PSWR, PSFF, PSFT, …). `/v1/status` `discovery.land.wide_accounted` counts them. Offline proof: `operator_playable` P6 (ports 41650+) | closed (code), loopback only | `keeper/src/feedguard.rs` `WideScope`, `keeper/tests/wide_feed_guard.rs` `p8::`, `stack/tests/operator_playable.rs` P6 |
| P9 | **Wide provinces kept resolved (devnet-p15-p9).** WideMuster and WideGarrison (and an expedition resident's Dissolve / Return) need the wide province resolved through bell − 2 (`resident_ok`: `resolved_next + 1 ≥ now_bell`, `NotResident` otherwise; `proc/wide.rs` `muster_as`, `proc/wide_garrison_exec.rs`) — a program rule, kept. Nothing sent the wide Resolve before (the `wideduty.rs` planner is read-only; `expeditions` resolves a destination only up to an arrival), so a wide village could muster only in its first bells. keeper A's new role **`wide-resolve`** (`--features playable-lane`; needs `beacon`) keeps every wide province it knows of — named by an accounted PSW1 record (the feed index, rebuilt from cursor 0 on restart) or holding a wide village won by a claim (the known Citizens' wide ticket records) — resolved bell by bell with the quiet wide Resolve (0xDC op 1, key `wres:<P>,<Q>:<bell>`) once THE anchor's window closed and the seed is on chain; a bell with arrivals is left to `expeditions` (each role skips the other's pending key). Class D fees only: 64,331 lamports a bell and province as measured offline (verify-pr129: 5,000 base fee + 59,331 priority fee, keeper A's class-D starting bid P_LOW_MILLI 100 on the role's 600,000 CU limit; a quiet Resolve uses about 84,000 CU), so about 0.065 SOL per known wide province for a 7-day season of 1,008 bells, at most about 7.0 SOL if all 108 wide provinces keeper A opens became known from the first bell; more if a write waits and its bid rises. Offline proof: `operator_playable` P11/P12's tail (a wide village claimed from the rim, WideMuster on a later bell with NO declared `resolved_next`) | closed (code), loopback test only (devnet-p15-p9) | `keeper/src/wideresolve.rs`, `proc/wide.rs` |
| P10 | **The expedition's records no longer stop keeper A (devnet-expedition-keeper); and (option (a) of P14, PR #124) neither does wide conquest.** A `playable-lane` keeper's feed guard now APPLIES the records of the expedition wrapper's kinds 0–11 exactly (`feedguard.rs` `WideScope::expedition`): PS2 146 (Depart, SettleOrigin), PS2 147 (Reveal, Gather), PS2 148 + PSW1 25 (SettleMember, SettleCamp, the pair adjacent and of one identity and receipt), PS2 149 + PSW1 26 (resident Dissolve / Return, one operation id), PSFF v1/v2/v3 (failure, forfeit, retained failure) and PSFT (terminal), each decoded by its own codec with the canonical identity checks (host home a legacy province of this Season's world, destination wide). What they change that the legacy indexes keep is applied as a hint the duties re-read: the home province (touched), a settled or failed holding's `pool_owed` (`owes`), and the transit for the `expeditions` role (P13). Still a blocker: an unpaired, forged, truncated or foreign record, any other format. (P14 option (a), devnet-guard-conquest, merged: the conquest kinds 12–18 — PSW1 18–24, PS2 145, PSWR, PSWC — are read exactly too; since P14 (b) the devnet `.so` cannot produce them.) Tests over the REAL logs of the pinned `.so` (`fixtures/verify/playable-*.json.gz`, every dispatch kind 0–18): `keeper/tests/expedition_feed_guard.rs`. (The legacy PS2 codec refuses all of 145–149, not 145–148: D-devnet-page-war-6, the doc fixed.) | closed (code) for expeditions; wide conquest closed in the devnet build by P14 (b) | `keeper/src/feedguard.rs`, `keeper/tests/expedition_feed_guard.rs`, `stack/tests/operator_playable.rs` P11 |
| P5 | **Fog of war on the devnet page (fog-devnet).** The play page of a season whose pinned cluster is `devnet` shows the same player view as a local test world (#93/#117): vision around one's own villages and hosts and one's own nation's villages and held provinces (allies share nothing); never-seen land blank on the map and 全体図; last-known records kept per season (program, Season id and Season account) and wallet in the browser; other nations' hosts, marches, clashes and contests only in current vision; no reveal at the season's end; no 「記録」 sheet and no spectator link on the play page. The switch is `DEVNET_FOG` (`map/fog.mjs`, beside `LOCAL_FOG`), keyed on the pin (`FS.pin.cluster`), not on the gateway's devnet play answer. It is a client view only: the herald (`/h/*`), the spectator page and the chain stay public, so anyone can read everything directly (owner: cosmetic fog accepted). Offline proof: `operator_playable` PFOG (`DEVNET_PAGE_DRIVER=1`, ports 41720+): P9's page war plus two observer players of other nations on the devnet page | closed (client), loopback only | `permutation-server/web/frontier/map/fog.mjs`, `app.mjs` `fogWorldPinned`, `stack/tests/operator_playable/war_fog.rs` |

## 8. The whole command list, in order (playable lane; 2026-11-21, `origin/main` 436bb9c1; re-checked 2026-11-22, 6912906d)

Every flag below was read from the code and, except where a line says otherwise, is the one the offline end-to-end
tests pass (`frontier-node/crates/stack/tests/operator_playable.rs`). **None of it has been run against devnet.**
Steps marked **[r0ze]** need r0ze's confirmation at the time. `$RPC` is the https devnet RPC r0ze chose (H1; the
public `https://api.devnet.solana.com` for the deploy and the operator). Ports stay in 41000–41999 on the operator
host, and only the herald is public, behind a TLS reverse proxy (what that proxy must do, and which ports must stay
closed: §8a).

```sh
# ── 0. Before anything [r0ze] ────────────────────────────────────────────────────────────────────────────────
# the preflight: one line per MUST item, PASS / FAIL / WARN / SKIP + the fix; read-only (never sends, never reads a
# key file, never spends SOL; no cluster contact without --rpc). Exit 0 = no FAIL. Run it until it shows no FAIL:
node scripts/devnet/preflight.mjs --build --solana4 ~/solana-4x/bin/solana          # toolchain, profile, key files, rebuild --twice + sha256, planner at 5,080
node scripts/devnet/preflight.mjs --rpc https://api.devnet.solana.com              # + the §3 read-only checks (B5: only when r0ze approves the read); a rent ≠ 5,080 adds the planner line at the measured rate
#   after steps 5–7 (services up, before opening the season) — ON THE HOST, from the repository root (it stats the keeper's
#   token / seed files there; relative paths in keeper.toml are relative to the repository root, the keeper's working directory):
node scripts/devnet/preflight.mjs --services <your start script> --keeper-config keeper-a/keeper.toml   # herald / gateway / keeper flags
#   and from a machine OUTSIDE the host (a clone of the repository; no keys there):
node scripts/devnet/preflight.mjs --public-url https://<host>
#   (TLS, /h/season cluster + program, /frontier/frontier/, the §8a 15-nudge X-Forwarded-For check, closed ports 41040/41050/41030/41033;
#    the offline lines FAIL there for the keys / 4.x CLI it does not have — read only the ep.* lines. Wait 20 s between two runs.
#    Flags and checks: scripts/devnet/README.md "Deploy-day preflight")
scripts/play-local.sh                 # the local play-check (t341u); then: scripts/play-local.sh --wide
# the read-only checks of §3 again (rent rate, BLS, SBPF v2, SIMD-0500), with the 4.x CLI (the --rpc line above reads the same)

# ── 1. Build, key-free (cargo-build-sbf 3.1.9) ───────────────────────────────────────────────────────────────
scripts/build-frontier-devnet-playable-sbf.sh --twice     # prints file_sha256 → H (today, P14 b: 67a33c92…06b3)
node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json   # plan + cost; gate CLOSED
# frontier-operator and frontier-verify in ONE command: `-p stack` alone does not compile (origin/main ed5fcd79, run again by verify-pr177: E0382
# — verify/src/vmsg.rs:83 moves a `Hash` that is `Copy` only when another package of the build turns on
# solana-hash's `copy` feature; devnet-dress-rehearsal D-dress-1)
(cd frontier-node && cargo build --locked --release -p stack -p verify \
   --features stack/playable-lane,verify/playable-lane --bin frontier-operator --bin frontier-verify)
(cd frontier-node && cargo build --locked --release -p keeper --features playable-lane --bin frontier-keeper)
(cd frontier-node && cargo build --locked --release -p herald \
   --features land-preview,wide-world-experimental,expedition-records-experimental --bin frontier-herald)
(cd permutation-gateway && npm ci --ignore-scripts)

# ── 2. Keys [r0ze], offline, outside the repository (§2) ─────────────────────────────────────────────────────
#   ~/wylls-devnet-keys/{deployer,program-playable,authority}.json, mode 600
#   their two addresses → "programId" and "upgradeAuthority" of scripts/devnet/devnet-playable-profile.json
#   faucet into the deployer (21.93 SOL at 5,080; 30.03 at 6,960) and the authority (57.14 SOL); keeper A's funders in step 5

# ── 3. Deploy [r0ze: "deploy OK" for H] (§5a) ────────────────────────────────────────────────────────────────
export PATH="$HOME/solana-4x/bin:$PATH"                    # solana CLI ≥ 4.0.0, for this step only
node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json \
  --i-have-r0ze-approval \
  --keypair ~/wylls-devnet-keys/deployer.json \
  --program-keypair ~/wylls-devnet-keys/program-playable.json \
  --upgrade-authority ~/wylls-devnet-keys/authority.json \
  --approved-sha256 $H
#   → solana program deploy … --max-len 4308992 --max-sign-attempts 50 (no --use-rpc, §5); program show; program dump (hash must equal program_hash)

# ── 4. Season start [r0ze] (§6b) ─────────────────────────────────────────────────────────────────────────────
B=frontier-node/target/release/frontier-operator
P=scripts/devnet/devnet-playable-profile.json
K=~/wylls-devnet-keys/authority.json
$B --profile $P --offline                                  # the plan, no RPC
$B --profile $P --authority $K                             # dry run on devnet: rent, balance, deployed sha256, gate
$B --profile $P --authority $K --yes-send --i-have-r0ze-approval --approved-sha256 $H --record ~/wylls-season-2.jsonl
#   → AnnounceSeason; exit 3 "CreateSeason opens at chain clock T"
#   24 h 5 min later, the same line → CreateSeason, InitBeaconLogs, InitShards × 6; exit 3 "WideSetRules needs the season Seeded"
#   start keeper A (step 5); about 21 min after T it consumes the genesis round; then the same line once more
#   → WideSetRules; exit 0 "setup complete"

# ── 5. Keeper A [r0ze: funding] (start it right after CreateSeason) ──────────────────────────────────────────
KP=frontier-node/target/release/frontier-keeper
mkdir -m 700 -p keeper-a && $EDITOR keeper-a/keeper.toml   # the file below
$KP --config keeper-a/keeper.toml --init-seed              # writes keeper-a/keeper.seed (mode 600) and exits
(umask 077; openssl rand -hex 32 > keeper-a/keeper.token)  # the API's bearer token: the keeper only reads this file
$KP --config keeper-a/keeper.toml --print-addresses        # its payers and funders; fund the FUNDERS (§4b: about 5.7 SOL
                                                           # of pools + the beacon's rent float + about 3 SOL of fees
                                                           # for SkipQuiet and wide-resolve); the keeper funds its payers
$KP --config keeper-a/keeper.toml                          # runs; GET 127.0.0.1:41050/v1/status with the token

# ── 6. Herald (the only public service, behind the TLS proxy) ────────────────────────────────────────────────
frontier-node/target/release/frontier-herald --data herald/ --program <PROGRAM_ID> --season 2 \
  --rpc $RPC --source rpc --cluster devnet --rpc-min-gap-ms 100 --poll-ms 1000 \
  --listen 127.0.0.1:41040 --web permutation-server/web --relay 127.0.0.1:41033 \
  --public-host <the public host name> [--witness <a second RPC>]
curl -s http://127.0.0.1:41040/h/season                    # "rulesetHash" → R (64 hex) for the gateway
#   the TLS proxy in front MUST set the client's address as X-Forwarded-For (fix-gw-highs, audit M-2), e.g.
#     nginx:  proxy_set_header X-Forwarded-For $remote_addr;      (NOT $http_x_forwarded_for: the client would choose it)
#     Caddy:  reverse_proxy 127.0.0.1:41040                         (default: sets it, ignores the client's own header)
#     HAProxy: http-request set-header X-Forwarded-For %[src]       (replace it; the herald reads the LAST entry over all lines, verify-pr166)
#   check it: two posts with different client-written X-Forwarded-For through the proxy must share one per-address bucket
#   and should cap header time and connections per client (client_header_timeout 10s; limit_conn), audit M-4

# ── 7. Gateway with the devnet play routes ───────────────────────────────────────────────────────────────────
FRONTIER_OPERATOR_TOKEN=<secret> node permutation-gateway/src/frontier/server.mjs \
  --cluster devnet --rpc $RPC --program <PROGRAM_ID> --season 2 \
  --port 41030 --public-port 41033 \
  --herald http://127.0.0.1:41040 \
  --keeper http://127.0.0.1:41050 --keeper-token-file keeper-a/keeper.token \
  --pool-size 150 --master-seed-file relay/relay-master.seed \
  --invite-secret-file relay/invite.secret --state-file relay/relay-state.json \
  --devnet-play --devnet-play-ruleset-hash $R \
  --public-proxy xff        # required off localnet without --dev: a herald-forwarded loopback client is then limited, not exempt

# ── 8. The page ──────────────────────────────────────────────────────────────────────────────────────────────
#   players open https://<the public host name>/frontier/frontier/ (NOT /frontier/ and not the bare name: with step 6's
#   --web permutation-server/web those show the old v9 lobby; §8a), connect a wallet set to devnet holding about 0.05 devnet SOL,
#   and play: Join → first village (heartland, or the rim once ring 128 is open, about 21 h after the genesis)
#   → Harvest / Build / Train → Muster → sealed march → wide claim (once keeper A opened ring 129)
#   → 2nd / 3rd village by FileOutpost (once keeper A's provinces_reach opened the provinces next to the home)
#   → rim → wide expedition (「境界への道を準備」: two presses, wallet-signed ExpeditionDepart; keeper A's expeditions role does the rest)
#   (devnet-dress-rehearsal D-dress-4: before #172 the page's Join → rim ticket STALLED when the herald's read lagged
#    the Join — 4 of 5 pages offline under load never filed their ticket. Fixed by #172 (fix-devnet-join-wait, merged
#    2026-11-23, 2057f89d: the page waits up to 180 s for its own record); with its page files 5 of 5 settled.)
#   (a fresh rim Hamlet's second village — FileOutpost or the wide claim — needs the settler cost from its harvests. The
#    program charges a second village 800 Food, 800 Wood, 400 Stone, 200 Gold (`settler_cost(holdings_n = 1)`; a third
#    1,200 / 1,200 / 600 / 300), and the FileOutpost card and the wide-claim card both quote that. (Until #183 the
#    wide-claim card quoted one step too high — 1,200 / 1,200 / 600 / 300 for the second — and kept its button off until
#    the store held that much, D-verify-pr177-1: in the offline rehearsal the outpost was filed at bell ~106 while the
#    wide-claim card still read short at bell 161. Fixed by #183, verify-pr183.))

# ── 9. Check and end ─────────────────────────────────────────────────────────────────────────────────────────
frontier-node/target/release/frontier-verify --program <PROGRAM_ID> --season 2 --rpc $RPC --witness <a second RPC> \
  --ruleset $R --program-hash $H --balances --out verify-report/ \
  --program-so permutation-frontier/target/deploy-devnet-playable-sbf/permutation_frontier.so
#   exit 0 PASS, 1 FAIL, 2 cannot verify (UNVERIFIABLE); report.json and report.md in verify-report/
#   season end at bell 1,008: frontier-operator end-season (§6c) — EndSeason, then after end + 72 h every close
#   (run this verifier inside the 72 h, before the closes, while the witness still serves the season; it also runs after);
#   ending the test: solana program close <PROGRAM_ID> --authority … --bypass-warning (§5)
```

**Keeper A's `keeper.toml`** (the devnet profile's `services.keeperA`: its `roles` and `ringsDuty`; the offline P11
run's file with the profile's three wide rings; unknown keys are refused):

```toml
program = "<PROGRAM_ID>"
season = 2
rpc = ["<$RPC>"]
feed = "rpc"
drand = ["https://api.drand.sh", "https://drand.cloudflare.com"]
roles = ["beacon", "archive", "rings", "fold", "tickets", "wide-tickets", "reveal", "settle-departure", "gather", "resolve", "skip", "settle", "close", "claims", "expeditions", "wide-resolve"]
reveal_pool = 150
delay_pool = 32
funders = 4
r99_reveals = 150
delay_floor = 50000000     # 0.05 SOL per delay payer (PLAYTEST-RUNBOOK §4); without it the default is 0.5 SOL and 32 payers want 24 SOL (§4b)
beneficiary = "<the operator's beneficiary address>"
api = "127.0.0.1:41050"
token_file = "keeper-a/keeper.token"
master_seed_file = "keeper-a/keeper.seed"
journal = "keeper-a/keeper.journal.sqlite"
extend = true
extend_max_ring = 128
lazy_provinces = true
rim_per_wedge = 6
provinces_reach = 3
# provinces_per_pass = 12, provinces_max = 600 (the defaults; the wedge-fund floor is the real bound, §6)
wide_rings = 3
wide_per_wedge = 6
rpc_min_gap_ms = 250
```

`wide-tickets`, `expeditions`, `wide-resolve` and `wide_rings` need the keeper built with `--features playable-lane`
(`config.rs` `check_wide`); `expeditions` needs `beacon`, `gather` and `resolve`; `wide-resolve` needs `beacon`;
`provinces_reach` (at most 8, `PROVINCES_REACH_MAX`; 3 is the preset's `outpost_range`) and `wide_rings` (at most 8) need `rings`. Unknown keys are refused.

`delay_floor` (lamports) sets the delay pool's band: a delay payer is drawn only at or above the floor (when none is,
the draw is over all of them), payer care tops a payer below it up to 1.5 × the floor and sweeps one above 2 × the floor
back down to 1.5 × (`frontier-node/crates/fclient/src/payers.rs` `Pool::draw`, `plan_care`; `keeper/src/pools.rs`).
At 0.05 SOL the first care pass moves about 2.4 SOL (32 × 0.075) into the delay pool and about 1.8 SOL (150 × 1.5 × F_r,
F_r ≈ 0.008 SOL at `r99_reveals = 150` and 5,080 lamports/byte) into the reveal pool; §4b's "delay 32 × up to 0.1" assumes
this line. Left out, the default 0.5 SOL floor asks 24 SOL of the funders (32 × 0.75) and a 12-SOL funding leaves 19
delay payers empty (devnet-s2-readiness RISK-1).

Notes on what is **not** tested as written:

- The offline runs use `--rpc-min-gap-ms 0` (herald) and no `rpc_min_gap_ms` (keeper) on loopback. 250 ms is the
  gap the verifier now defaults to after the public endpoint's limit was measured (#123); the keeper's and the
  herald's own default is still 150 ms.
- The herald's `--rpc-min-gap-ms 100 --poll-ms 1000` (§8 step 6; was `--rpc-min-gap-ms 250` with the default poll
  200) was measured offline (fix-devnet-join-wait: P7 behind a proxy that shows every transaction 30 s late, as
  devnet's finality + ingest would; herald-load-50: 50/100 players): every call waits for the gap, so with 250 the
  herald is pinned at ≈ 4 calls/s whether idle or busy (getSignaturesForAddress + the Clock read every 200 ms poll)
  and falls behind in bursts (100 players ×5: lag p95 16 s, max 90 s); with 100/1000 it idles at ≈ 1.8/s, bursts
  to 10/s, and showed a Join 25 s sooner (p95 lag 4 s at 100 players). The poll costs at most 1 s of latency next to
  ≈ 13 s of finality. On the public endpoint (≈ 1 call/method/s) neither setting fits: it is for a provider endpoint.
  Paid cost (from these call counts; price sheets were not read in that run): idle ≈ 4.8 M calls per 30 days, plus
  ≈ 2 calls per program transaction (50 players acting 6 times a bell ≈ +2.6 M per 30 days); on a plan that counts
  a standard call as one credit, budget ≈ 8 M credits per 30 days for the herald alone — a devnet season (7 days + the 24 h lead + about 21 h of
  map growth, ≈ 9 days of herald uptime, players acting for 7 of them) is ≈ 2 M (verify-pr172) (the gateway adds
  ≈ 1 call/s + ≈ 6.5 per player act, herald-load-50 §5; keeper A not measured).
- The page waits for the herald up to 3 minutes after its own Join / rim village request / PlaceHome
  (`frontier/fown-wait.mjs`, fix-devnet-join-wait), with the wait said on the card and a 「もう一度確かめる」 button after
  it; a herald lagging more than that (a stalled RPC) shows that button, never a silent stop.
- The offline runs' gateway runs with `--dev --pool-size 1 --devnet-play-offline-rpc` (the TEST form: loopback
  41000–41999 only). Without `--dev` the gateway needs `--pool-size` ≥ 150 (`config.mjs`); the devnet play routes
  are wallet-paid and are not funded routes, so that relay pool need not be funded for them [from code; not run].
- The offline page runs' herald is built with `wide-world-experimental,expedition-records-experimental` (CI's
  key-free run builds the default herald; its browser runs skip). `land-preview` is added here because the devnet
  `.so` links the land preview, `play-local.sh` builds the herald with all three, and the gateway's
  `playable-lane-profile.mjs` `devnetHeraldArgs` asks for it (without it the herald does not keep the land
  records as captures); that three-feature herald has run on local play only, not in the devnet-shaped tests. The
  default herald build answers `503 WideWorldUnavailable` on `/h/world/wide`.
- The offline keeper file has no `archive` role, `r99_reveals` or drand `https` URL (it reads a local
  `drand-replay`); those lines are the profile's roles, PLAYTEST-RUNBOOK §4's value and `keeper/src/config.rs`'s
  URL rule (`https`, or `http` on loopback). With the `claims` role, ClaimDefence is signed and paid by the
  beneficiary: add `beneficiary_key_file = "keeper-a/beneficiary.key"` and fund that address too (RUN-A-KEEPER
  §4.4); the offline runs set no such key.
- `frontier-verify`'s line is the shape of #123's read-only runs on foreign programs (`--rpc`, `--witness`,
  `--balances`) with the lane's `--ruleset` (the Season's hash; the default is the build's own S1 one),
  `--program-hash` and `--program-so`, read from `verify/src/main.rs`; that combination has not been run on a
  public RPC. With `--rpc` it also reads the Rent sysvar at the final states' slot and re-executes under it (stderr
  and the report's `rent` say `chain`); if that read fails, add `--lamports-per-byte <the §3 rate>` (`declared`),
  else the report says `assumed` (5,080). A PASS needs the witness to serve the whole season (§7.0 W1); without one the answer is
  UNVERIFIABLE, never PASS.
- The season timeline on devnet's clock: the 24 h announce lead; about 21 min to the genesis seed; about 21 h of
  map growth (one ring per 10-minute bell) to ring 128, when rim villages become possible; one more bell per wide
  ring; a sealed march arrives 2–72 bells after its Depart; a keep falls after 72 held bells (12 h); the
  continuous world (season 2) never ends (a 7-day preset season ends at bell 1,008).

### 8a. Public endpoint checklist (security audit 2026-11-22; read from the code on `origin/main` a193b633, i.e. with #164's fixes)

No TLS proxy is configured anywhere yet, and no test has one in front of the herald: the proxy settings below have
not been run. Each line names the code it was read from. The `nginx` words are examples of the setting meant, not a
tested file. What the herald itself does (the redirects, the two pages, `HostNotAllowed` / `OriginNotAllowed`, the
headers, no header-read timeout, the 64 KiB and 2 MiB body limits) was re-checked against a running herald on
loopback (verify-pr165).

**The one public address.** TLS port 443 on the proxy (80 only to redirect to https) → the herald on
`127.0.0.1:41040`. Proxy these paths and nothing else: `/frontier/*` (the page), `/h/*` (reads; `WS /h/ws`),
`/gw/*` (the gateway's public routes, which the herald itself forwards to `--relay 127.0.0.1:41033`), and `/`.

**The page's address is `https://<host>/frontier/frontier/`.** The herald serves `--web DIR` under `/frontier/`
and answers `/` and `/frontier` with a 302 to `/frontier/` (`herald/src/server.rs` `router`, `web`). With step 6's
`--web permutation-server/web`, `/frontier/` is `permutation-server/web/index.html`, the old v9 lobby (it calls
`/api/*`, which this stack does not serve); the game is `permutation-server/web/frontier/index.html`, one level
down. Every offline page test opens `/frontier/frontier/` (`operator_playable/war_page.rs`, `expedition.rs`,
`war_fog.rs`). Give players that address; to make the bare name work too, let the proxy answer exactly `/` and
exactly `/frontier/` with a redirect to `/frontier/frontier/` (a proxy rule; the herald has no such redirect).

**Client address: the proxy MUST set `X-Forwarded-For`, and its last entry must be the address the proxy itself saw.**

- Run the proxy on the same host as the herald, so the herald's peer is loopback. Only then does the herald read
  the header, and it reads the **last** entry (`server.rs` `client_ip`). It forwards that address to the gateway
  (`/gw/*`, and the quota read of `/h/me`), and the gateway trusts it only from the herald's loopback address
  (`permutation-gateway/src/frontier/app.mjs` `clientAddress`).
- Right: `proxy_set_header X-Forwarded-For $remote_addr;` or `$proxy_add_x_forwarded_for` (it appends the address
  the proxy saw, so the last entry is right). Caddy's `reverse_proxy` default does the same [Caddy's documented
  default; not tested here].
- **No header at all** (nginx sends none unless told to): every request reaches the gateway as `127.0.0.1`, and
  the gateway exempts loopback addresses from every per-address limit (`app.mjs`: `!isLoopback(ip)` before
  `FRONTIER_IP_LIMITS`). All of them switch off at once and nothing logs it (audit M-2: 60 of 60 nudges passed).
- **Passing the client's own header through** (`proxy_set_header X-Forwarded-For $http_x_forwarded_for;`): a
  client writes `127.0.0.1` itself and is exempt (audit M-2, 60 of 60).
- No other header is read: `X-Real-IP` and `Forwarded` do nothing. A proxy on another host is itself the "client"
  for everyone (one shared bucket). With a CDN in front of the proxy, `$remote_addr` is the CDN's address: restore
  the real one first (nginx `set_real_ip_from` + `real_ip_header`, the CDN's ranges only).
- Check before the season opens: from an outside address send 15 `POST /gw/f/nudge` with an empty JSON body in one
  second. The limit is counted before the route reads the body (`app.mjs` `handle`; 10 at once, then one every 2 s
  since #166, `FRONTIER_IP_LIMITS` `'POST /f/nudge': { burst: 10, perSecond: 0.5 }`): the first 10 get the route's own
  refusal (`400`), the rest must be `429`. If none is `429`, the header is wrong. (Rehearsed offline by
  devnet-dress-rehearsal through a TLS stand-in proxy: 10 × `400`, 5 × `429`; the same client with a forged
  `X-Forwarded-For` stayed in its bucket, `429`; another client got its own; a foreign `Host` got `403`.)
- The herald's own cap of 64 `WS /h/ws` sockets per client address (#164: `server.rs` `WS_PER_CLIENT`, `429
  TooManySocketsFromClient`) uses the same `client_ip`: without the header every visitor is `127.0.0.1` and all of
  them share one allowance of 64.
- **Since fix-gw-highs (#166, merged 2026-11-22):** the gateway refuses to start off localnet without `--dev` unless
  it has `--public-proxy xff|none` (`config.mjs`), and with `xff` it limits a herald-forwarded loopback address as one
  shared bucket (counted and logged) instead of exempting it. So with step 7's `--public-proxy xff` the "No header at
  all" bullet above no longer switches the limits off: every visitor then shares ONE bucket (a proxy that sends no
  header locks real players out instead of letting abuse through), and the "Passing the client's own header through"
  bullet no longer exempts anyone either (a loopback address the herald forwards lands in that same shared bucket;
  other forged addresses still get a bucket each, so only the global caps of `keeper-guard.mjs` hold there). The
  header rule above stays the same.

**`Host`, `Origin`, CORS.**

- Every request's `Host` must be loopback or a `--public-host` name, else `403 HostNotAllowed` (`server.rs`
  `HostPolicy`; no opt-out). Either pass the public name on (`proxy_set_header Host $host;`) and give it as
  `--public-host`, or leave nginx's default (`127.0.0.1:41040`, a loopback name). `--public-host` is needed in both
  cases: `WS /h/ws` checks a browser's `Origin` against the same list (`403 OriginNotAllowed`).
- `WS /h/ws` needs the upgrade passed on (`proxy_http_version 1.1`, `Upgrade` and `Connection` headers) and a read
  timeout above the herald's 15 s ping (`ws.rs`; nginx's 60 s default is enough).
- The herald sets the security headers itself on every answer: the CSP (`connect-src 'self'` on the page, so the
  page, `/h` and `/gw` must be one origin), `X-Frame-Options`, `Referrer-Policy`, `X-Content-Type-Options`. The
  proxy must not remove or replace them and must not add CORS headers. `/h/*` already answers
  `Access-Control-Allow-Origin: *` (public data); `/gw/*` and `/frontier/*` answer none, on purpose. Only `WS /h/ws`
  checks `Origin`; `/gw/*` does not, and its acting routes need a wallet signature instead.

**TLS.** The herald speaks plain HTTP only; TLS ends at the proxy. Redirect 80 → 443 and add
`Strict-Transport-Security` at the proxy (the herald does not send it). The RPC provider's URL (`$RPC`) usually
holds an API key: it stays in the service command lines on the host and is never served.

**Timeouts and connection limits (the herald has none of its own for these; audit M-4).**

- The herald has no header-read timeout and no connection cap (`axum::serve` defaults): 300 connections sending
  one header line every 5 s all stayed open. The proxy must end slow requests and buffer them:
  `client_header_timeout 10s; client_body_timeout 10s; proxy_request_buffering on;` and a per-address connection
  limit (`limit_conn`). Never expose the herald's port without such a proxy.
- A `/gw/*` answer may take up to 90 s (`server.rs` `GW_TIMEOUT`; connect 5 s): set the proxy's read timeout for
  `/gw/` above that (nginx `proxy_read_timeout 95s;`; its 60 s default would cut a slow answer the herald is still
  waiting for).
- `/h/*` is public and has no rate limit in the herald: limit it per address at the proxy (`limit_req`). `WS /h/ws`
  has 8,192 places in all (`ws.rs` `max_sockets`) and, since #164, at most 64 per client address (audit M-3); 128
  addresses can still fill it, so limit connections per address at the proxy too.

**Body size.** Every public request with a body is a `/gw/*` POST of at most 64 KiB (`server.rs` `GW_MAX_BODY`;
the gateway's own `FRONTIER_MAX_BODY_BYTES` is the same). The herald checks that only after axum has buffered the
body, up to axum's 2 MiB default (audit L-11). Set `client_max_body_size 64k;` at the proxy.

**Ports that must NOT be public** (firewall: inbound 443 and 80 only; everything below stays on loopback):

| Port (step 5–7 values) | What | What the code enforces |
|---|---|---|
| 41040 | herald | **nothing**: `--listen` takes any address (only the port range is checked, `herald/src/main.rs`). Keep `--listen 127.0.0.1:41040` |
| 41050 | keeper A's API (`/v1/*`, bearer token) | refuses a non-loopback `api` (`keeper/src/config.rs`, `api.rs` `serve_full`) |
| 41030 | gateway, operator listener (operator token) | always binds `127.0.0.1` (`permutation-gateway/src/frontier/server.mjs`) |
| 41033 | gateway, public listener | refuses a non-loopback `--public-host` (`config.mjs` `checkFrontierConfig`); reached only through the herald's `/gw` |
| — | ③ MCP servers | not started by anything; loopback only. The public one is default OFF and r0ze's decision (`workstreams/03-composability/mcp/PUBLIC-EXPOSURE.md` §7, §9); the owner one is never public |
| 419xx and others | local-play services (launcher, runner RPC with time control, local relay, world proxy, `--external` MCP) | TEST only: never start `scripts/play-local.sh` or a `frontier-localnet` on the public host |

**The live devnet host (2026-11) runs the same four on ports 100 higher: keeper A's API on 41150**, herald 41140,
gateway 41130 (operator) / 41133 (public) — `scripts/devnet/health.mjs` (`ports`) reads those, and r0ze chose 11-26 10:52
to record keeper A at 41150 as the live setup uses it. The values in this runbook (steps 5–7 and the table above) are
still 41050/41040/41030/41033 because `scripts/devnet/preflight-checks.mjs` requires them (`cfg.keeper` wants
`api = "127.0.0.1:41050"`; `ep.ports` probes 41040/41050/41030/41033 by default — pass `--private-ports 41140,41150,41130,41133`
for the live host). Which set the repo should hold everywhere is open (owner-answers-ui report, Q-OAU-1).

Also never public: the key files of steps 2 and 5 (`keeper.seed`, `keeper.token`, the relay's seed and invite
secret, `FRONTIER_OPERATOR_TOKEN`) and the directories `keeper-a/`, `relay/`, `herald/`. Everything under
`--web DIR` is served: point it at `permutation-server/web` and nothing wider, and keep no key file below it.

**Still open in the code (not closed by any proxy setting):** keeper A ends on a panic or a fatal journal error and
needs a supervisor (RUN-A-KEEPER §6). (Audit H-1 and H-2 — anyone making keeper A spend its RPC budget through
`/gw/f/reveal` and `/gw/f/nudge` — were closed by fix-gw-highs, #166, merged 2026-11-22: keeper A refuses forged
reveals and far-future nudges before any RPC, the gateway caps both routes per address and globally.)
