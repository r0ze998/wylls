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
