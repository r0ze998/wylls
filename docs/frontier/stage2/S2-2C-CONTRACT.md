# Stage 2c: receipt tickets (contract)

Design: `docs/design/redesign/20-stage2-play.ja.md` §2 and §5,
`32-stage2-build-plan.ja.md` decisions L3 and L5 (adopted 2026-10-24).
Builds on 2a (receipt issues, lots, V26) and 2b (shared vaults). Every
number marked [phase 6] is a placeholder. [proposal] marks a choice this
contract makes where the design left it open; they are listed for the
owner in §9.

**Status (2026-10-24):** built — program, ABI, LiteSVM (`tests/receipts.rs`;
ClaimReceipt 11,693 CU, WithdrawReceipt 30,353), fclient, verifier (V23
models the roll and the reservation on every send and settle; V26 judges
claims and withdrawals; tampers T64–T65), herald, relay (profile 4) and the
web (issue a receipt on one's vault, claim, collect).

## 0. Scope

| 2c (this contract) | Later |
|---|---|
| Claiming a day's receipts, the daily pro-rata at the day boundary (L5), withdrawing the grant by caravan (L3) | Use runs (2d), escrow (2e) |
| The owner's sends never take what was granted | The AI (2f) |
| Program, ABI, LiteSVM, fclient, verifier, herald, relay, web | |

## 1. The model

- A receipt issue (2a) promises, per unit and per day, `PER_UNIT` milli of
  one resource from one vault, until `UNTIL_DAY`.
- **A day is a period** (L5; `travel::BELLS_PER_DAY` bells).
- **Claiming** (`ClaimReceipt`, day D): a holder claims its lot's whole
  entitlement for D, `AMOUNT × PER_UNIT`. The vault adds it to the day's
  claims of that resource. A lot claims once a day.
- **The day boundary.** A vault's stock changes only through
  instructions. So the first instruction of day D+1 that touches the
  vault's stock or claims sees the stock exactly as day D left it. That
  instruction **rolls** the vault before anything else:
  - for each resource, `ratio = min(1, stock / claims_D)` (in parts per
    million, rounded down), and `reserved = min(stock, claims_D)`;
  - day D's claims are cleared; the ratio and the reservation hold for day
    D+1 only.
- **Withdrawing** (`WithdrawReceipt`, day D+1): a lot that claimed on day D
  sends a caravan of `⌊claim × ratio⌋` (whole units) of the resource out of
  the vault to the holder's place. The reservation shrinks by as much. A
  claim not withdrawn on day D+1 lapses [proposal].
- **The owner's sends** (SendCaravan out of the vault) may not take what is
  reserved for the day. Everything else stays the owner's: receipts are a
  promise, and a shortfall shows in the ratio, logged with every withdrawal
  ("守れなかったことは記録に残る").
- **Gifts during a claim.** Units given out of a lot that claimed today
  arrive "claimed today" in the recipient's lot, so no unit is claimed twice
  in a day. A gift into an existing lot that has not claimed today is then
  refused (`ReceiptState`).
- **Void.** A seizure (a new generation) voids the receipts (2a) and clears
  the vault's claims and reservation.
- Receipts stay impossible on a shared vault (2b): a claim or withdrawal
  on a shared vault is refused (`VaultShared`), and OpenShares refuses a
  vault with a claim or grant outstanding after its roll (`ReceiptState`).

## 2. Accounts

### 2.1 Vault (S1, 512 B): the receipts' period, from its reserve

| Field | Off | Type | Meaning |
|---|---|---|---|
| `CLAIM_DAY` | 248 | u32 | the day whose claims `CLAIMS` holds (0: never claimed) |
| `RES_DAY` | 252 | u32 | the day the vault last rolled; `RATIO` and `RES` hold for it |
| `CLAIMS` | 256 | [u64;8] | milli claimed on `CLAIM_DAY`, per resource |
| `RES` | 320 | [u64;8] | milli still reserved on `RES_DAY`, per resource |
| `RATIO` | 384 | [u32;8] | parts per million granted on `RES_DAY` to the claims of `RES_DAY − 1` |

**Days are stored plus one** (0 means never), here and in the Lot's
`DAY`, so that day 0 can be claimed. The reserve shrinks to 96 bytes at 416.
A vault that never had a claim
(`CLAIM_DAY = RES_DAY = 0`) never rolls, so S1 and 2b flows write nothing
new.

### 2.2 Lot (2a): `DAY` and `DAY_AMOUNT`

`DAY` is the day the lot last claimed; `DAY_AMOUNT` the milli it claimed
then, set to 0 when withdrawn.

## 3. The roll

`roll(vault, today)`, run first by every instruction below that touches a
vault with `CLAIM_DAY ≠ 0`:

```
if RES_DAY != today:
    for r: if CLAIM_DAY == today − 1 and CLAIMS[r] > 0:
              RATIO[r] = min(1e6, ⌊stock[r] × 1e6 / CLAIMS[r]⌋)
              RES[r]   = min(stock[r], CLAIMS[r])
           else: RATIO[r] = 0 (1e6 when nothing was claimed), RES[r] = 0
    RES_DAY = today
if CLAIM_DAY != today: CLAIMS = 0, CLAIM_DAY = today
```

It runs in: ClaimReceipt, WithdrawReceipt, SendCaravan from a vault,
SettleCaravan and SettleDeposit into a vault (when delivered), and 2d's use
runs later. `ticket::roll` holds it; the verifier replays it.

## 4. Instructions (tags 0xC6–0xC7)

### 4.1 ClaimReceipt (0xC6, player) — no data

Accounts: P + `[lot w] [issue r] [vault w]`.

- The lot is the citizen's, live, not in escrow, of a live receipt issue
  valid now (the vault in the issue's generation), `today ≤ UNTIL_DAY`.
- Roll; then `lot.DAY ≠ today` (claimed once a day) and the lot has no
  claim of yesterday still to withdraw (`ReceiptState`).
- `claim = AMOUNT × PER_UNIT` (> 0); `lot.DAY = today`, `lot.DAY_AMOUNT =
  claim`; `vault.CLAIMS[r] += claim`.
- Record `RECEIPT_CLAIMED`.

### 4.2 WithdrawReceipt (0xC7, player) — `seq u32, dst_kind u8, dst_p i16, dst_q i16, dst_at u8, dst_gen u8, steps u8, path [u8;12], fee u64`

Accounts: P + `[lot w] [issue r] [src w] [dst r] [caravan w] [system]
[path_province w ×1..4]`.

- The lot as ClaimReceipt's; roll; `lot.DAY = RES_DAY − 1` and
  `DAY_AMOUNT > 0` (`ReceiptState`).
- `grant = ⌊DAY_AMOUNT × RATIO[r] / 1e6 / 1000⌋ × 1000` (> 0, else
  `ReceiptState`); `RES[r] −= grant`; `lot.DAY_AMOUNT = 0`.
- The caravan is SendCaravan's (the destination rule, the path, the
  towers), the vault paying the grant.
- Records `CARAVAN_SENT` and `RECEIPT_WITHDRAWN`.

### 4.3 Changes

- **SendCaravan** out of a vault: roll first; the cargo of resource `r`
  may not exceed `stock[r] − RES[r]` while `RES_DAY = today`
  (`Insufficient`).
- **SettleCaravan / SettleDeposit** into a vault: roll first (when
  delivered).
- **SeizeVault:** clears `CLAIM_DAY`, `RES_DAY`, `CLAIMS`, `RES`, `RATIO`.
- **GiveLot** of a receipt lot (§1 "Gifts during a claim").

### 4.4 Error

`ReceiptState` (98): "already claimed today, nothing to withdraw, or
yesterday's claim not yet withdrawn".

## 5. Records (S2)

| Kind | Key | Payload | Chains |
|---|---|---|---|
| `RECEIPT_CLAIMED` (109) | issuer_tag u64, seq u32 | holder_tag u64, lot_tag u64, lot_seq u32, day u32, claim u64, claims u64 (the vault's, after), src Place (8) | Lot, Vault |
| `RECEIPT_WITHDRAWN` (110) | issuer_tag u64, seq u32 | holder_tag u64, lot_tag u64, lot_seq u32, day u32, claim u64, ratio_ppm u32, grant u64, caravan_seq u32 | Lot |

The vault of a withdrawal is chained by the same transaction's
`CARAVAN_SENT`.

## 6. Off chain

- **Verifier.** V26 judges ClaimReceipt and WithdrawReceipt (the roll, the
  claim, the grant, the reservation); V23 judges the withdrawal's caravan
  and, for every send and settle on a vault, the roll and that no send
  took reserved goods. Tampers: a grant above the ratio (T64), a claim
  counted twice in a day (T65).
- **Herald.** `h/tickets.json` lots gain `day` and `claim`; issues gain the
  last withdrawal ratio (`ratioPpm`, `ratioDay`).
- **Relay (profile 4).** ClaimReceipt: 0; WithdrawReceipt: a caravan's
  cost.
- **Web.** On one's own unshared vault, issue a receipt (2a's
  IssueTickets); one's receipt lots with "claim today" and "withdraw
  yesterday's". Both stay offered on the day after a claim: a grant that
  rounds to 0 lapses and today's claim is then allowed, and the feed has no
  ratio before a withdrawal, so the program decides.

## 7. Tables

`ticket.rs`: `TICKET_VERSION` 3 (the roll and the grant), `RATIO_ONE =
1_000_000`; `RULESET_HASH_V4` re-pinned.

## 9. For the owner: choices this contract makes

1. **A claim lapses** if not withdrawn on the next day (one day to send
   the caravan). A longer window would need a reservation per day.
2. **The snapshot is the stock at the day boundary**, taken by the first
   instruction of the new day that touches the vault. The owner may still
   empty the vault before midnight; the ratio then shows the shortfall
   (the design's "均等割りで減るだけ").
3. **One ratio per resource and vault.** Several receipt issues on the same
   resource of one vault share the day's stock in proportion to their
   claims.
4. **A gift during a claim day** marks the recipient's lot as claimed for
   the day.
