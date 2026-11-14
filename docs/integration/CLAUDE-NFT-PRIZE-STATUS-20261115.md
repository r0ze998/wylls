# ⑰ NFT prize connection: status at the 2026-11-15 04:15 stop

Written read-only after the supervisor's 04:15 limit. Nothing here was run for this record. Every result below cites the commit and run it came from.

## 0. What the 04:15 limit stops

- Never retried, by any route (other runner, mint, prize E2E): NFT transfer-safety checks and the A→B→A / strict / compat variants.
- No host build, no real world, no cache deletion. My option (A) itest build (`cargo test -p itest --features localnet-conquest-play --lib --bins`) is **withdrawn**, not pending. Main was told.
- ⑳ is now limited to the normal game's world generation and UI. Its final review of my controller/join patch is postponed until the prize work is back in its scope.

## 1. Branches (GitHub matches local, checked 2026-11-15)

| Branch | Head | What |
|---|---|---|
| `claude/nft-prize-connect-20261114` | 03e2b04f | Carried candidate, contract/host/SVM tests, designs |
| `claude/nft-prize-on-world-r21-20261115` | 04ac5358 (+ this record) | Port onto ⑳'s local-play candidate (base e50b3cc0, 13ac8f63 merged) |

## 2. Proven: what actually ran, and passed

| Evidence | Result | Where |
|---|---|---|
| Prize program lib, default and `nft-experimental` | 9/9 each | connect branch, guarded host run |
| registry / error_codes | 1/1, 3/3 | connect branch; features program/no-entrypoint only, so no evidence for the gated/NFT side |
| `nft_pass_prize` host (current owner, former owner refused, A→B→A generations, double claim, session) | 10/10 | connect branch f4a0e70a |
| LiteSVM TEST ONLY against the real Core (515541c8…) and resident (947da0b9…) binaries; TEST ONLY prize .so 1cf41f7b… | 7/7 | connect branch 1eb146d7; TEST ONLY artefact, never the production build |
| Check script for the TEST ONLY build | 17/17 | connect branch |
| Gateway prize JS (fixture entry 6/6, shares ledger 3/3, ABI order 3/3, pass connect 9) | pass | connect branch |
| Browser fixture of the English prize screen | 1/1 | connect branch, static fixture page |
| Local-play prize relay, key-free | 10/10 | port branch |
| Relay with in-memory Ed25519 test keys (one ticket per digest, race re-check, cfg snapshot, runId+instance pinning) | 9/9 | port branch 09a21ae4; listed in `scripts/ci/node-key-tests.txt` |
| Launcher `--prize-test-only-so` | 3/3 | port branch 8270a589 |
| Page local claim (fprize) | 6/6 | port branch 1b7cb922 |

Kept refusals (unchanged, tested): new NFT deposits (PayResident → 0x11B), continuous-world pools (0x112), production `build-prize.sh` NFT refusal, default features, normal output.

## 3. Source only: written, never compiled or run

- `frontier-node/crates/itest/src/prize_test_only.rs` (option (A) core, 5 tests), sha256 94a76fe61fcb8f09…, plus one gated lib.rs line. **Not compiled.** The build that would check it is withdrawn.
- Controller/join wiring (⑳'s files, on my branch only): patch `CLAUDE-NFT-PRIZE-PORT-20-FILES-PROPOSAL-20261115.patch`, sha256 e981a6a9…. Not applied, final review postponed. The earlier version (8627a536) had ⑳'s review OK.
- Option (A) spec (agreed with ⑳): `CLAUDE-NFT-PRIZE-RUNNER-OPTION-PROPOSAL-20261115.md`.

## 4. Missing for integration

### 4a. Source not yet written
1. Option (A) remainder: TEST ONLY prize deploy at [0x50;32] with a test mint and a real InitPool (flag only); the `Options` hook; the runner's stdin one-shot reader; the first-line `prize_test_only` keys; a byte-identical default first-line golden test; the launcher precondition (reads asset and owner before sending the line).
2. Mounting `local-play-prize.mjs` into the relay server (⑳'s file).
3. The E2E driver (runId/manifest check against `frontier_status`).

### 4b. Not yet proven, needs a run nobody has approved
1. Compile and run `prize_test_only` (withdrawn).
2. Anything in a real local world: the relay mounted, the page claim end to end, the TEST ONLY pool. Needs review, a resource slot, a df re-measurement and agreed cleanup.
3. Positive re-transfer (A→B→A) in a world. **Blocked:** the 0x51 TransferResident signs no generation, so replay of an old transfer within its blockhash lifetime is unsolved on chain, and the strict-variant work is stopped by the 04:15 limit. Nothing here may be called transfer-safe.

### 4c. Open by decision, not by work
- Refund owner and prize period: undecided economic rules. Not decided here.
- Weights, ties and "no eligible member": the screens already say undecided (provisional).
- 0x111 CeilingPastTally registry entry (⑧'s code): reported, not mine to add.
- The CI key list can't be regenerated while 10 pre-existing stale reviews remain (scanner exit 5); left to the list's owner.
- The relay's RPC-check → send window (TOCTOU) is recorded as a boundary, not closed.

## 5. Wording

A fixture-placed Entry is never "a successful deposit". A TEST ONLY artefact is never the production build. Compressed-clock results are never "natural".
