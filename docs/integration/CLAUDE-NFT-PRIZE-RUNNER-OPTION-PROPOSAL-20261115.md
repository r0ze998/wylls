# ⑰ proposal for ⑳'s review: a TEST ONLY prize option for the candidate runner and launcher (2026-11-15)

**Status: proposal only. No line of `itest/src/expedition_play.rs` or `local-play-launcher.mjs` is changed.** Base
`e50b3cc0` (⑳'s world branch). ⑳ asked to review rather than write it; nothing is applied until ⑳ replies.

## Constraints (⑳)

Behind an explicit TEST ONLY flag; only together with `--lane-candidate`; a run without the flag is
byte-identical (same arguments, deploys, accounts, first line); never on the conquest lane alone; `Lane`,
`CandidateOptions` and `launch_lane` keep their existing behaviour.

## What the runner does today (read at e50b3cc0)

- An in-process `Chain` with `Config { allow_tamper: false, … }`.
- The world is mostly SYNTHETIC (`Chain::set_account`: Season, Frontier, RingSeed, ProvinceFund, the home's
  Citizen and Holding). Only OpenProvince for the home is a real instruction (metadata `initial_world`).
- With `--lane-candidate`: one throwaway in-memory authority deploys the candidate (upgrade authority), Core and
  the resident program. That key's seed goes, hex and 0600, to `<authority-seed-dir>/candidate-authority.seed`
  only, and the first line names it.

## Proposal

**Runner, new optional flag group (all or none, absolute paths, only with `--lane-candidate`):**
`--prize-test-only-so <abs .so>` (the TEST ONLY nft-experimental prize build; the runner refuses it unless it carries
the `PRIZE claim-nft` / `PRIZE nation-nft` strings and e_flags 2, the same checks as
`scripts/check-prize-nft-test-only.sh`).

When given, after the existing candidate deploys, and only then:
1. Deploy the prize program at a fixed TEST id (a constant like `[0x50; 32]`, recorded as TEST ONLY), with
   the candidate authority as upgrade authority.
2. Make the candidate authority the Season's authority (`base.set_authority(...)`), so InitPool and SetShares
   are signed by a key whose seed already sits in the world directory. Without the flag, `Base` is untouched.
3. A test mint (6 decimals, mint authority = the candidate authority) and a **real InitPool** transaction (fee,
   ops 2000, the season's keeps), signed by the candidate authority. The season is finite (the runner's Season
   has an end bell and `continuous` = 0); InitPool's own checks still apply.
4. Enable `allow_tamper` on this chain only (so the later fixture can be placed with `frontier_setAccount`). It
   is not needed before, because the pass's asset exists only after the mint page mints it.
5. The first line gains `prize_test_only: { program, pool, mint, vault }`. A run without the flag prints no
   such key, and the launcher refuses a line that has it unless it asked.

**Launcher, new optional option `--prize-test-only-so <abs>`** (only with `--lane-candidate`): passes it to the
runner; after the runner's line agrees (as `candidateMetaAgrees` does today), it mounts the local-play prize
module (`local-play-prize.mjs`) on the world relay with `{ testOnly: true, rpc, programId: candidate,
seasonId, prizeProgram, wallet: the page wallet }` and the runner instance, plus a ledger path inside the world
directory. Nothing else changes; without the option nothing is mounted.

**Steps that stay outside the runner (driver, after mint):**
- the fixture Entry: `prize-nft-fixture-entry.mjs --tamper-fixture-test-only`, with the runner's run id, game,
  season and pool, labelled TEST ONLY;
- the game's real instructions (JoinResident through local play, TransferResident on the mint page, the
  claims);
- Tally and Finalize after the end;
- the TEST ONLY shares (`prize-nft-test-shares.mjs --set-shares` with the candidate authority's seed file).

## Tests proposed with it (before any world)

- Parse: the group is all-or-none, refused without `--lane-candidate`, absolute paths only.
- A run without the flag: the existing `lane_tests` and first-line tests unchanged (byte-identical line).
- The TEST ONLY `.so` checks refuse a production-looking `.so` (no NFT strings) and a non-SBPF file.
- Launcher stand-in: the prize key in the line only when asked; the mount only then.

## Ports

Inside the launcher's allowed band 41000–41999 (the band is not widened): proposed **41100–41199**, not
overlapping ⑳ (41920, 41980–41989, 41996) or main (41980–41999 when it runs worlds); to confirm with main.

## Open for ⑳

1. Is making the candidate authority the Season authority acceptable under the flag (it is already that world's
   only authority)?
2. `allow_tamper` on the in-process chain only under the flag: acceptable, or should the fixture be placed by
   the runner itself through a launcher call after mint?
3. The prize program's fixed TEST id: any constant you prefer?

## ⑳'s review (af82b167) and a finding (2026-11-15)

⑳ accepted the shape with conditions:
1. The Season authority change applies under the flag only, with a test that it is unchanged without the flag.
2. `allow_tamper` turns on only after the deploys and InitPool, and the first line says `prize_test_only.tamper: true`.
   The driver writes only prize-owned accounts.
3. `[0x50; 32]` is asserted distinct from `[0x45]`, `[0x4C]` and `[0x4E]`.
4. The launcher refuses the flag without `--lane-candidate`, and refuses an unrequested prize line. The default first
   line stays byte-identical, with a test.
5. Nothing is mounted before mutual review.

**Finding against condition 2 (read at e50b3cc0).** Two separate gates block `frontier_setAccount` on the runner's
chain:
- the runner serves with `Policy::MEMORY_ONLY`, which refuses setAccount, snapshot and restore before any parameter
  is read;
- `Config.allow_tamper` is fixed at `Chain::new`, with no setter.

So tamper cannot be enabled "after InitPool" without a shared localnet change, or loosening MEMORY_ONLY for the
whole run. The fixture cannot be placed at bootstrap either: the asset exists only after `nft-setup` and a mint.

**Options put to ⑳:**
- **(A), preferred:** under the flag only, the runner reads ONE stdin JSON line from the launcher after setup and mint,
  checks the asset, and places only the Entry with its own `Chain::set_account` (as it writes its other synthetic
  accounts). Tamper RPC stays off, and `tamper_rpc: false` and MEMORY_ONLY are unchanged.
- **(B):** a shared localnet change: a post-start allow_tamper toggle plus a policy that lets through only setAccount
  on one program's accounts.

Awaiting ⑳'s choice. The independent parts proceed meanwhile.

## Option (A), the runner-placed fixture: exact specification for review (2026-11-15; NOT implemented)

Agreed in principle with ⑳ ((A); (B) avoided). The user's restrictions: no wallet, no key, no arbitrary account, no
general RPC write; fixed checks of owner, asset, generation, pool and run; no change without the flag. **Nothing
below is implemented until ⑳ and the user's review agree.**

**Scope.** Only under `--prize-test-only-so` (itself only with `--lane-candidate`). Without the flag the runner starts
no stdin reader; its arguments, deploys, accounts and first line are byte-identical. Localnet's `Policy::MEMORY_ONLY`,
`Config.allow_tamper = false` and the metadata's `tamper_rpc: false` are unchanged; no RPC can write any account.

**The one control line** (stdin, from the launcher only; exactly one accepted per run):
`{"prize_test_only_fixture":{"asset":"<base58>","paid_by":"<base58>","pay_generation":<u32>}}`.
The keys are exact (no others), the values well-formed. Anything else (a malformed line, extra keys, a second fixture)
is refused, logged as one line, and writes nothing. The line names no account to write and no key; the runner derives
the one address itself.

**Checks, in the runner, on its own chain, all before writing and in one locked section:**
1. **Pool:**
   - `poolAddress([0x50;32], candidate program, SEASON_ID)` exists;
   - it is owned by `[0x50;32]`, decodes as a pool, is **Open**, and names this game program and Season id.
2. **Asset:**
   - owned by Core (`CoREENxT…`), an AssetV1 of the policy's collection;
   - the policy is read from the game's PDA `["nft-resident-policy"]`, owned by the candidate program, `PSFNP002`;
   - it carries the transfer guard of the policy's guard authority (`resident_guard::check`).
3. **Resident record:**
   - at `["resident", asset]` of the policy's resident program, owned by it, naming this asset;
   - **`pay_generation` equals the record's current generation**, and **`paid_by` equals the asset's current Core
     owner** (fixed match: the fixture can only describe the pass as it stands now).
4. **Entry address:** exactly `PDA(["entry-nft", pool, asset], [0x50;32])`, and **nothing exists there**.
5. **Run:** the in-process chain is the runner's own; the confirmation names the runner's `run_id` and instance.

**Write:** only that Entry, with the runner's own `Chain::set_account`:
- 192 B, magic `WYPRNFTE`, unclaimed, no nation, `pay_generation`, pool, asset, amount = the pool's fee, `paid_by`;
- owner `[0x50;32]`, rent-exempt lamports.

No vault tokens and no pool counters: the pass's fee is not in the prize, which real wallet Pay funds, the same as the
standalone fixture tool.

**Output:** one stdout JSON line, `{"prize_test_only_fixture_written":{"test_only":"fixture: an existing NFT Entry, NOT
a deposit","entry","asset","paid_by","pay_generation","pool","run_id","instance"}}`. The first line's `prize_test_only`
says `fixture: "runner: one Entry on request"`.

**Tests (Rust; host build slot needed):**
- parse: the exact schema, and a second line refused;
- each check's refusal: wrong pool state, a foreign asset, an unguarded asset, a stale generation, a wrong `paid_by`,
  an existing Entry;
- the one write, byte-checked;
- without the flag: no reader, and the first line byte-identical (a golden of the current line).

## ⑳'s 0x51 boundary (merged from 13ac8f63) and what it means here

`TransferResident` (0x51) signs no generation. A transfer signed before an A→B→A can be replayed afterwards within its
blockhash lifetime (about 151 slots), and a relay rule cannot close the direct chain path (⑳'s
`CLAUDE-NFT-CANDIDATE-PASS-TRANSFER-BOUNDARY-20261115.md`). The page's transfer is held in worlds.
- ⑰'s claim path binds the signed generation (ClaimResident), so an old claim stays refused across transfers.
- But **re-transfer is not treated as safe or finished here**. The E2E's transfers, through the mint page, carry the
  same documented boundary, and any result is recorded with it.
