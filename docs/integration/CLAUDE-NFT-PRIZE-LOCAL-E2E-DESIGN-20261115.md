# ⑰ NFT prize: local world E2E (transfer → claim through the relay and the English page) — design (2026-11-15)

**Status: design plus two light tools; no world started.** Branch `claude/nft-prize-connect-20261114`.
Local loopback only: no real funds, no public RPC, no public mint, no real wallet. The production prize build
(`scripts/build-prize.sh`) and every authority/fund guard stay as they are. New pass deposits, pass refunds
and pools on continuous worlds stay refused; no undecided rule (refund owner, prize period) is decided here.

## 1. What is new compared with the LiteSVM tests (7/7)

The LiteSVM tests ran the real prize (TEST ONLY SBF), Core and resident programs, but wrote the game's
accounts as bytes. This E2E runs the **real game program** (⑳'s NFT lane), the **real keeper/herald/relay**,
and the **page in English**, so that JoinResident, the Citizen, the link, the season's end and the game's own
CloseCitizen are real, and the claim goes through `POST /f/prize/claim` and the page's 賞金 panel.

## 2. The one explicit fixture (and what it is not)

The prize program refuses every pass deposit (`ResidentDepositsDisabled`). An existing pass Entry can only
stand for one from before that rule, so the E2E places **one Entry per pass** on the loopback chain with
`scripts/prize-nft-fixture-entry.mjs --tamper-fixture-test-only` (frontier-localnet `frontier_setAccount`, only
when the localnet runs with `--allow-tamper`). It writes only the Entry (owner = prize program, unclaimed, no
nation). It does **not** put the pass's fee in the vault or the pool's counters: the prize is funded only by
**real** wallet `Pay` instructions. Every record calls it a TEST ONLY tamper fixture; **it is never reported as
a deposit**. Pure tests: `test/prize-nft-fixture-entry.test.mjs` (5/5: layout, loopback-only, refusals before
any request, refusal of an absent/foreign pool, absent asset, existing Entry; one account written).

## 3. World options (handshake with ⑳ pending)

- **A (preferred if ⑳ agrees): extend `frontier-stack`** so `--nft-pass` can run with `--prize-so <TEST ONLY
  .so>` on a finite season, and pass `--allow-tamper` to the localnet only under an explicit fixture flag. It
  reuses the stack's prize module (test mint, gate, InitPool, faucet) and ⑳'s nft-setup. Cost: one
  `frontier-stack` host rebuild (est. 1+ GiB, guarded). The stack's `--nft-pass` is ⑳'s code (`e2b522fc`):
  ⑳ decides or makes the change.
- **B: drive from outside.** Run ⑳'s `frontier-stack up --nft-pass` unchanged, then deploy and initialise the
  prize program with a separate driver. Blocked today: the stack has no way to pass `--program` or
  `--allow-tamper` to its localnet, so the fixture Entry and the prize program cannot be added without a
  stack change either. So B also needs a small stack change, or a localnet started by hand.

Pins to agree with ⑳ before any world: the commit of `frontier-node/nftpass-bin`, the lane `.so` (runbook
`0227dbe1…` deploy-localnet-nft-sbf vs today's `404633c8…` localnet-conquest-nft-sbf 0xC804), and that the lane
can create a **finite** season (InitPool refuses continuous seasons and `r_max` or the cq `r_max_ceiling` past
17). The relay and page come from **this** branch (the NFT prize routes and the pass panel exist only here;
base `0ebfe040`); ⑳ to confirm no route/ABI drift since then.

## 4. The sequence (two passes, so both stories run in one world)

Keys: local test keys only, in memory or 0600 per-run files, never printed or committed (as ⑳'s runbook).
Wallets: A, B (pass holders), C and D (wallet players who `Pay` and fund the prize).

1. World up (agreed slot, ports base 42100; nothing of ⑳'s 41000 or main's 41980–41999).
2. A mints passes P1 and P2 (real MintResident, mint page or driver).
3. **Fixture:** an Entry for P1 and for P2 (`paidBy` A, generation 0). Recorded as tamper.
4. A joins with P1 and P2 from the English page ("Join with this NFT"): with a pool and an Entry, the page's
   plan is `joinPaid`: a plain JoinResident through the relay's settled x402 path, no fee (real JoinResident,
   real NFT Citizen and link). C and D `Pay` and join normally.
5. Play to the finite end (compressed clock, labelled compressed). Tally and Finalize (real, permissionless).
   **Shares — open choice (§6):** real achievements via `prize-settle.mjs`, which needs the passes to have
   earned points in play, or a TEST ONLY shares ledger posted by the operator's real SetShares. The ledger
   would be labelled; it is not the provisional achievements ledger.
6. RecordResidentNation for P2 (real); the game's **CloseCitizen** for P2's Citizen after `end + 72 h`
   (compressed; real instruction). P2's claim must still work.
7. **P1: A → B** (real TransferResident). On the English page: A sees "not in this wallet now" and no claim
   button; B claims (real ClaimResident via `POST /f/prize/claim`); balances read over RPC; B's second claim
   → "already claimed"; A's old-generation signature → ResidentStaleGeneration in words.
8. **P2: A → B → A** (real, generation 2). B and A's generation-0/1 attempts refused; A's session key refused;
   A claims once at generation 2; then "already claimed".
9. Evidence: every signature and status, account bytes before/after (vault, token accounts, Entries),
   English screenshots of each panel state, one JSON transcript. Then stop and clean up (§7).

## 5. Light tools in this round

- `permutation-gateway/scripts/prize-nft-fixture-entry.mjs`: the fixture (above).
- `permutation-gateway/test/web-frontier-prize-abi-order.test.mjs`: the claim/record account lists agree
  across the program, the page SDK and the LiteSVM test (3/3, negative control).
- To write once ⑳ answers: the E2E driver (steps 2–8 over loopback RPC, relay and page) and the stack change
  if option A.

## 6. Open (owner decisions, not made here)

- Shares in a short test world: real achievements (needs play that earns points) or a labelled TEST ONLY
  shares ledger. The provisional weights stay provisional either way.
- Refund owner, prize period on continuous worlds, wallet ↔ NFT migration: untouched; refunds and
  continuous pools stay refused.

## 7. Stop and cleanup (planned)

Stop with the stack's own `stop_all` (or the driver's). Copy the evidence (transcript, signatures,
screenshots, hashes) to the scratchpad and the doc; then remove only this run's own run dir and its own
targets, with sizes recorded. Never another session's world, ports, run dirs or caches.

## 8. Proven / unproven (now)

Proven so far (host 10/10, LiteSVM 7/7): the claim rules with the real Core/resident programs. **Unproven
until this E2E runs:** the real game program's JoinResident/CloseCitizen with the prize, the relay's claim
route against a chain, the English page's claim flow, and real-chain timing. A deposit stays unproven by
design (refused).
