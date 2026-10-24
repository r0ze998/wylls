# Stage 2b: share tickets (contract)

Design: `docs/design/redesign/20-stage2-play.ja.md` §2–§5 and
`32-stage2-build-plan.ja.md` decisions L1–L3 and L8 (adopted 2026-10-24).
Builds on 2a (`S2-2A-CONTRACT.md`): the Issue and Lot accounts, the ticket
records, V26, the relay's profile 4. Every number marked [phase 6] is a
placeholder. [proposal] marks a choice this contract makes where the design
left it open; they are listed for the owner in §9.

**Status (2026-10-24):** built — program, ABI, LiteSVM (`tests/shares.rs`),
fclient, keeper (SettleDeposit), verifier (V23, V26, V7; tampers T62–T63),
herald (`h/tickets.json`, the vaults' `shares`), relay (profile 4) and the
web (open, the shares list, withdrawals home). Not yet: the web cannot
deposit into **another player's** shared vault, because that send needs
the wallet's signature and the page signs sends with the session key
(2f); the AI and the simulator do not use shares yet (2f).

## 0. Scope

| 2b (this contract) | Later |
|---|---|
| Opening a vault's shares (a share issue of kind 1) | Receipts' withdrawals and the daily pro-rata (2c) |
| Depositing by caravan: a caravan delivered into a shared vault mints shares to its owner | Use runs (2d) |
| Withdrawing by caravan: a holder burns shares and sends a caravan of the basket out of the vault | Escrowed exchanges (2e) |
| Closing a share issue; a seizure voids the shares | The panels' polish and the AI (2f) |
| Program, ABI, LiteSVM, fclient, keeper, verifier, herald, relay, web | |

## 1. The model

- **A share is a fraction of the vault.** A share issue's `SUPPLY` is the
  number of units outstanding; a holder of `a` units owns `a / SUPPLY` of
  every store. Nothing accrues to a unit, so a gift needs no settlement
  (design §5 "settle at every transfer" holds by construction).
- **Value** counts mixed stores in one number (L2): `value = Σ ⌊store_r /
  1000⌋ × SHARE_VALUE[r]` (`ticket::value_of`; science and influence are
  worth 0 and cannot be stored in a vault anyway).
- **Opening** (`OpenShares`): the vault's owner turns it into a shared
  vault. The owner receives units equal to the vault's value now. The fee
  is the issue fee (L8).
- **Depositing**: any caravan delivered into a shared vault mints units to
  the caravan's owner (its holder at settlement, so a taken caravan's
  raider). `minted = ⌊dv × SUPPLY / v0⌋`, where `v0` is the vault's value
  before the credit and `dv` the value the credit added (the vault's cap
  can cut the credit; only what is credited counts). When `SUPPLY` is 0
  the depositor takes `dv + v0` (the remainder left by rounding);
  when `v0` is 0 and `SUPPLY` is not, `minted = dv × SUPPLY` [proposal]:
  units of an empty vault are worth nothing, so the depositor ends with
  nearly all of it.
- **Withdrawing** (`WithdrawShares`, L3): a holder burns `amount` units and
  sends a caravan out of the vault carrying the basket `⌊store_r × amount /
  SUPPLY⌋` of each store, in whole units. What rounding leaves stays in the
  vault for the others. The caravan is the holder's: its fee, its route and
  its risk.
- **The owner is a holder like any other.** A plain `SendCaravan` out of a
  shared vault is refused (`VaultShared`), as is `CloseVault` and issuing a
  receipt on it. The owner withdraws with shares.
- **Void on seizure.** A seizure raises the vault's generation (1b) and
  clears its shares; every lot of the old issue is void (2a). The goods are
  the captor's. A caravan that was on its way names the old generation and
  is lost at settlement, as in 1b.
- **Closing.** The issuer closes the share issue with `CloseLot` once its
  supply is 0, or once it is void (2a's rule). Closing it clears the
  vault's shares; the vault is the owner's own again.

## 2. Accounts

### 2.1 Vault (S1, 512 B): three fields from its reserve

| Field | Off | Type | Meaning |
|---|---|---|---|
| `SHARES_ON` | 232 | u8 | 1 while a share issue of this vault is live and in this generation |
| `SHARES_SEQ` | 236 | u32 | the issue's `seq` |
| `SHARES_ISSUER_TAG` | 240 | u64 | the issue's `issuer_tag` |

The reserve shrinks to 264 bytes at 248. An S1 vault reads 0: unshared.

### 2.2 Deposit lots

A holder's lot of a share issue lives at a **deposit address**, so that a
settlement can find it without reading the holder's Citizen:

- seed `tl ‖ holder_tag ‖ deposit_seq`, with `holder_tag =
  addr::citizen_tag(holder Citizen)` and
- `deposit_seq = 0x8000_0000 | (le_u32(sha256("PSF-DLOT" ‖ issuer_tag ‖
  issue_seq)[0..4]) & 0x7fff_ffff)` (`frontier_abi::v2::addr::deposit_seq`).

`Citizen.LOTS` counts below `0x8000_0000`, so the two never meet. A deposit
lot is never given whole in place (`GiveLot` to itself is refused); a gift
splits it into a new ordinary lot. Two share issues whose deposit seqs
collide for one holder would need about 2³¹ issues; if it happens, the
deposit is credited and mints nothing (logged `minted 0`) [proposal]. A
deposit lot closed empty is created again at the next deposit.

The opener's own units go to the opener's deposit lot.

## 3. Instructions (tags 0xC3–0xC5)

### 3.1 OpenShares (0xC3, player) — no data

Accounts: P + `[holding w] [holding_province r] [vault w] [issue w] [lot w]
[system]`.

- The vault is the citizen's, live, and not shared. The paying holding is
  the citizen's, final and unlocked (as IssueTickets).
- `OPEN_ISSUES < MAX_OPEN_ISSUES`; the fee is paid and burned.
- Creates the Issue (`KIND_SHARE`, source the vault in its generation,
  `SUPPLY = value_of(stores)`, `PER_UNIT 0`, `UNTIL_DAY NO_END`, `seq =
  Citizen.ISSUES`) and the opener's deposit lot with the whole supply.
- Writes the vault's shares; `ISSUES += 1`, `OPEN_ISSUES += 1` (`LOTS`
  unchanged).
- Record: `SHARES_OPENED` (it chains the vault too).

### 3.2 WithdrawShares (0xC4, player) — `seq u32, amount u64, dst_kind u8, dst_p i16, dst_q i16, dst_at u8, dst_gen u8, steps u8, path [u8;12], fee u64`

Accounts: P + `[lot w] [issue w] [src w] [dst r] [caravan w] [system]
[path_province w ×1..4]`.

- The lot is the citizen's, live, not in escrow, of the vault's live share
  issue, in the issue's generation; `0 < amount ≤ lot.AMOUNT`.
- The basket is not empty (`BadData`).
- Everything else is SendCaravan's: the caravan's seq, the fee, the
  destination (another player's place needs the wallet), the path and the
  slots, the towers' wear. The vault pays the basket.
- `lot.AMOUNT −= amount`, `issue.SUPPLY −= amount`.
- Records: `CARAVAN_SENT` (as SendCaravan) and `SHARES_WITHDRAWN`.

### 3.3 SettleDeposit (0xC5, settle) — `beneficiary [u8;32]`

Accounts: `[fee_payer s] [season] [caravan w] [dst w] [beneficiary w]
[rent_to w] [issue w] [lot w] [system] [path_province r ×1..4]`.

- SettleCaravan's checks and outcome, for a caravan whose destination is a
  vault with live shares. `SettleCaravan` refuses that destination
  (`VaultShared`); `SettleDeposit` refuses any other.
- When delivered: the issue is the vault's; the lot is the caravan owner's
  deposit lot (created when absent, its rent from the fee payer); the units
  minted by §1 are added to it and to `SUPPLY`.
- A lost delivery (the vault seized or gone) is SettleCaravan's:
  SettleDeposit refuses it (`BadAccount`), as it refuses a holding or an
  unshared vault. The keeper picks the instruction from the vault's state
  and falls back to SettleCaravan.
- The deposit lot is created before any lamports move (a system-program
  call after a direct lamport move unbalances the instruction).
- Records: `CARAVAN_SETTLED` and, when delivered, `SHARES_DEPOSITED`.

### 3.4 Changes to existing instructions

- **SendCaravan:** a shared vault as the source → `VaultShared`.
- **SettleCaravan:** a shared vault as the destination → `VaultShared`.
- **CloseVault:** a shared vault → `VaultShared`.
- **IssueTickets:** a receipt on a shared vault → `VaultShared`.
- **SeizeVault:** clears the vault's shares.
- **CloseLot:** closing a share issue clears its vault's shares; its
  `source` becomes writable.
- **GiveLot:** a deposit lot given in place → `BadData`.

### 3.5 Error

`VaultShared` (97): "this vault's goods belong to its share holders".

## 4. Records (S2)

| Kind | Key | Payload | Chains |
|---|---|---|---|
| `SHARES_OPENED` (106) | issuer_tag u64, seq u32 | src Place (8), supply u64, lot_seq u32, holding_key u64, fee digest [u8;32] | Citizen, Holding, Vault, Issue, Lot |
| `SHARES_DEPOSITED` (107) | issuer_tag u64, seq u32 | holder_tag u64, lot_seq u32, value u64, minted u64, supply u64 (after), caravan_tag u64, caravan_seq u32, new_lot u8 | Issue, Lot |
| `SHARES_WITHDRAWN` (108) | issuer_tag u64, seq u32 | holder_tag u64, lot_tag u64, lot_seq u32, amount u64, supply u64 (after), caravan_seq u32 | Lot, Issue |

`LOT_CLOSED` gains `src` (Place, 8) and `shares_cleared` (u8); when set,
the record chains the vault after the Citizen.

The basket itself is the cargo of the same transaction's `CARAVAN_SENT`;
the delivery is the same transaction's `CARAVAN_SETTLED`.

**Budgets (measured in LiteSVM):** OpenShares 24,961 CU, WithdrawShares
30,104, SettleDeposit 22,640 (budgets 40,000 / 120,000 / 50,000). The S2
release `.so` is 1,456,040 B: the S1 loaded-limit table now assumes a
1.5 MiB `.so` (`PLACEHOLDER_SO_LEN_S1`), and `REVEAL_LOADED_LIMIT_S1`
follows (2,031,616).

## 5. Off chain

- **Verifier.** V26 judges OpenShares, WithdrawShares (the shares and the
  basket; V23 judges the caravan as a SendCaravan from the vault) and
  SettleDeposit (the minting; V23 judges the delivery). V23 refuses a plain
  SendCaravan or SettleCaravan on a shared vault. V7 takes OpenShares' fee
  as IssueTickets'. Tampers: units minted beyond the rule (T62), a basket
  larger than the burned share (T63).
- **Keeper.** Settles a caravan into a shared vault with SettleDeposit.
- **Herald.** `h/tickets.json` folds the deposits and withdrawals; a
  seizure voids the vault's share issue; `h/caravans.json`'s vaults gain
  `shares: {issuerTag, seq} | null`.
- **Relay (profile 4).** OpenShares: rent(Issue) + rent(Lot);
  WithdrawShares: a caravan's cost (as SendCaravan); SettleDeposit (a
  settle shape): rent(Lot).
- **Web.** The vault panel opens shares on one's own vault and shows a
  shared vault's supply and one's units; the tickets list shows one's lots;
  a withdrawal form sends the basket home.

## 6. Tables

`ticket.rs`: `TICKET_VERSION` 2 (the deposit and basket rules);
`RULESET_HASH_V4` is re-pinned.

## 7. Tests

- `permutation-rules`: minting, the basket, value.
- `frontier-abi`: the vault fields, the deposit seq, the new tags, records
  and error.
- `svm-tests/tests/shares.rs`: open; deposit by another (shares minted,
  lot created) and by the owner (added); withdraw a basket home; the
  owner's SendCaravan, CloseVault and a plain SettleCaravan refused;
  seizure voids (withdraw refused, the issue closes); close the issue.
- `verify`: V26's new judges and the tampers.
- Herald, gateway, web: the folds, the allowances, the shapes.

## 9. For the owner: choices this contract makes

1. **Depositing is any delivery into a shared vault.** No separate
   "deposit" order: send a caravan to the vault and the units follow at
   settlement. A gift to a shared vault is therefore impossible.
2. **Units of an empty vault** (supply left, value 0) are nearly worthless
   against a new deposit (§1).
3. **The deposit address** is derived from the holder and the issue
   (§2.2), so the settler need not read the holder; a deposit lot cannot be
   given whole in place.
4. **No receipts on a shared vault** until 2c decides how receipts and
   shares share a vault.
