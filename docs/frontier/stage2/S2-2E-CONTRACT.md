# Stage 2e: escrowed exchange (contract)

Design: `docs/design/redesign/20-stage2-play.ja.md` §1 ("引き換えの預かり"),
`32-stage2-build-plan.ja.md` decisions L6 and L7, and
`29-remaining-decisions.ja.md` A3 (adopted 2026-10-24). Builds on 2a (lots,
`ESCROW`), 2c (the vault's period) and 1b (caravans). [proposal] marks a
choice this contract makes; they are listed for the owner in §9.

**Status (2026-10-24):** built — program, ABI, LiteSVM (`tests/escrow.rs`;
OpenEscrow 15,435 CU, AcceptEscrow 10,625, CancelEscrow 9,975,
WithdrawEscrow 28,649), fclient, verifier (V26 judges the four
instructions; V23 the collection's caravan and `stock − HELD` in every
send and roll; tamper T67), herald (`escrows` in `h/tickets.json`) and the
relay (profile 4). The web lists escrows naming the viewer (accept,
cancel, collect); opening one from the web is not built yet.

## 0. Scope

| 2e (this contract) | Later |
|---|---|
| An exchange between two citizens: goods held in a vault, or a whole lot | Tradeable delivery tickets (kind 4), several items a side |
| Open (the maker's side held), accept (the taker's side, the swap at once), cancel, collect the goods by caravan | The AI (2f) |
| Program, ABI, LiteSVM, fclient, verifier, herald, relay, web | |

## 1. The model

- **An escrow** names two sides: the **maker** (who opens it) and the
  **taker** (a citizen the maker names). Each side gives one item:
  - **goods:** `amount` milli of one resource, from one of the giver's own
    unshared vaults; or
  - **a lot:** one whole lot of the giver's (not a share deposit lot).
- **Open** (`OpenEscrow`): the maker's item is put in escrow at once:
  - goods are **held in place** (L6): the vault's `HELD[r]` grows by the
    amount, and nothing held may leave the vault by the owner's sends, use
    runs or receipt reservations;
  - a lot is marked with the escrow (`ESCROW`), so it cannot be given,
    used, claimed or closed.
- **Accept** (`AcceptEscrow`, by the taker, before the deadline): the
  taker's item is put in and **the swap happens in the same instruction**
  (both present, so "両方そろったら同時に交換" holds by construction):
  - a lot changes holder in place (the escrow mark cleared);
  - goods stay held and become **owed** to the other side, who collects
    them by caravan (`WithdrawEscrow`, L6: the right to send that amount
    out of that vault). The hold is released as they leave.
- **Cancel** (`CancelEscrow`): before acceptance, the maker may cancel at
  any time, and anyone may after the deadline [proposal]: the maker's item
  is released (the hold lifted, the lot unmarked) and the escrow closes.
- **Void goods.** A seizure of the holding vault (a new generation) clears
  its holds: goods owed from it are void. A party may then close the
  escrow (`CancelEscrow` on a settled escrow whose remaining goods are all
  void).
- **Signers (L7):** every escrow instruction may be signed by the session
  key: both parties consent (the maker by opening, the taker by
  accepting).

## 2. Accounts

### 2.1 Escrow (kind 25, entity kind 15, seed `te` ‖ maker_tag u64 ‖ seq u32; 272 B)

`seq` is the maker's `Citizen.LOTS` at opening (the counter moves by one)
[proposal: one counter for the citizen's lots and escrows].

| Field | Off | Type | Meaning |
|---|---|---|---|
| STATE | 64 | u8 | 1 open, 2 settled (goods owed) |
| RSV_65 | 65 | 3 | |
| SEQ | 68 | u32 | |
| DEADLINE_BELL | 72 | u32 | Acceptance is refused after it |
| OPENED_BELL | 76 | u32 | |
| MAKER | 80 | Side (80) | |
| TAKER | 160 | Side (80) | |
| RENT_TO | 240 | [u8;32] | The opener's payer: the rent at close |

**Side** (80 B): `CITIZEN [u8;32]` @0, `TAG u64` @32, `KIND u8` @40 (1
goods, 2 lot), `STATE u8` @41 (0 promised, 1 in escrow, 2 owed, 3 done),
`RESOURCE u8` @42, `GEN u8` @43 (the vault's), `P i16` @44, `Q i16` @46,
`TILE u8` @48, rsv @49 (7), `AMOUNT u64` @56 (goods milli; a lot's units),
`LOT_TAG u64` @64, `LOT_SEQ u32` @72, `STAMP u32` @76 (a goods side's
vault: the low 32 bits of its `BUILT_TS`). A goods side names the
vault by `P, Q, TILE, GEN`; a lot side the lot by `LOT_TAG, LOT_SEQ`.

The account is 272 B (`RENT_TO` ends at 272).

### 2.2 Vault (S1): `HELD`, from its reserve

| Field | Off | Type | Meaning |
|---|---|---|---|
| `HELD` | 416 | [u64;8] | milli held for escrows, per resource |

The reserve shrinks to 32 bytes at 480. The owner's sends, use runs and
the receipts' roll see `stock − HELD` (the roll: `ratio` and `RES` are
computed on it). A seizure clears `HELD`. A vault with goods held cannot
be closed (its stores are not 0).

## 3. Instructions (tags 0xC9–0xCC)

### 3.1 OpenEscrow (0xC9, player)

Data: `deadline_bell u32, taker_tag u64, give_kind u8, give_resource u8,
give_p i16, give_q i16, give_tile u8, give_amount u64, give_lot_tag u64,
give_lot_seq u32, want_kind u8, want_resource u8, want_amount u64,
want_lot_tag u64, want_lot_seq u32`. Goods are in whole units (`amount`
a multiple of 1000 milli: a caravan carries whole units).

Accounts: P + `[escrow w] [taker_citizen r] [give_src w] [system]`, where
`give_src` is the maker's vault (goods) or lot (lot).

- `deadline_bell > now`, at most `ESCROW_MAX_BELLS` ahead (7 days)
  [proposal]; the taker is another citizen.
- Goods: the vault is the maker's, live, unshared; rolled (2c); `amount >
  0` and `amount ≤ stock[r] − RES[r] − HELD[r]` (`Insufficient`);
  `HELD[r] += amount`.
- A lot: the maker's, live, valid, not in escrow, not a deposit lot, with
  units; `ESCROW = escrow id` (`seq` + 1 of the maker's escrow, nonzero).
- `want` is only recorded (the taker's side, `STATE 0`); a goods want
  names the resource and amount (the vault is the taker's choice at
  accept); a lot want names the lot and the units it must hold at
  acceptance (`want_amount`, review fix: the taker cannot split it first).
- Goods amounts are at most `ESCROW_MAX_GOODS` (10⁹ units' milli; review
  fix: a wrapping amount would have turned a hold negative).
- `Citizen.LOTS += 1`. Record `ESCROW_OPENED`.

### 3.2 AcceptEscrow (0xCA, player) — `vault_p i16, vault_q i16, vault_tile u8`

Accounts: P + `[escrow w] [maker_src w] [taker_src w]`
(the maker's item, the taker's: a vault or a lot).

- The escrow is open, the signer's citizen is the taker, `now ≤
  DEADLINE_BELL` (`EscrowState`).
- The taker's item is checked as the maker's at opening (goods: from the
  taker's vault named in the data, which becomes the side's vault).
- The swap: each lot side's lot gets the other party as holder (`ESCROW`
  0); each goods side becomes owed (`STATE 2`), its hold kept.
- `STATE 2` (settled). With no goods owed (a lot for a lot) the record's
  `closed` is set and a party closes the escrow with CancelEscrow (the
  instruction has no rent account).
- Record `ESCROW_SETTLED`.

### 3.3 CancelEscrow (0xCB, player)

Accounts: P + `[escrow w] [rent_to w]` + `[src w ×1..2]` (the maker's item
when open; each owed goods side's vault when settled).

- Open: by the maker any time, by anyone after the deadline. The maker's
  item is released.
- Settled: by either party, once every owed goods side is void (its vault
  seized or closed) or none is owed.
- The escrow closes. Record `ESCROW_CANCELLED`.

### 3.4 WithdrawEscrow (0xCC, player)

Data: as WithdrawReceipt's (`seq, dst…, steps, path, fee`), plus `side u8`
(0 maker's goods, 1 taker's goods).

Accounts: P + `[escrow w] [src w] [dst r] [caravan w] [system] [rent_to
w] [path_province w ×1..4]`.

- The escrow is settled; the side is owed goods, the signer's citizen is
  the other party; the vault is live in the side's generation.
- `HELD[r] −= amount`; a caravan of `amount` (whole units) to the
  receiver's place, as SendCaravan's (the destination rule, the path, the
  towers), the vault paying.
- The side is done (`STATE 3`); with nothing owed left, the escrow
  closes.
- Records `CARAVAN_SENT` and `ESCROW_WITHDRAWN`.

### 3.5 Changes

- **2a GiveLot, CloseLot; 2c ClaimReceipt, WithdrawReceipt; 2b
  WithdrawShares; 2d UseRun:** a lot in escrow is refused (already: `ESCROW
  ≠ 0`).
- **SendCaravan, UseRun, the roll:** see `stock − HELD`.
- **SeizeVault:** clears `HELD`.

### 3.6 Error

`EscrowState` (101): "the escrow is not open (or not settled), its
deadline has passed, or the signer is not its party".

## 4. Records (S2)

| Kind | Key | Payload | Chains |
|---|---|---|---|
| `ESCROW_OPENED` (112) | maker_tag u64, seq u32 | taker_tag u64, deadline_bell u32, give_kind u8, give_amount u64, lot_tag u64, lot_seq u32, src Place (8; the goods' vault, zeros for a lot), want_kind u8, want_amount u64, want_lot_tag u64, want_lot_seq u32, rent_to [u8;32], give_resource u8, want_resource u8 | Citizen, the vault or the lot, Escrow |
| `ESCROW_SETTLED` (113) | maker_tag u64, seq u32 | taker_tag u64, maker_kind u8, taker_kind u8, maker_lot_tag u64, maker_lot_seq u32, taker_lot_tag u64, taker_lot_seq u32, src Place (the taker's goods' vault), closed u8 (nothing owed) | the taker's vault, the lots, Escrow |
| `ESCROW_CANCELLED` (114) | maker_tag u64, seq u32 | by_tag u64, released u8 (the item kind released, 0 none), lot_tag u64, lot_seq u32, src Place | the released vault or lot, Escrow |
| `ESCROW_WITHDRAWN` (115) | maker_tag u64, seq u32 | receiver_tag u64, side u8, amount u64, caravan_seq u32, closed u8 | Escrow (the vault by the same transaction's CARAVAN_SENT) |

## 5. Off chain

- **Verifier.** V26 judges the four instructions (the holds, the swap, the
  closes); V23 the withdrawal's caravan and `stock − HELD` in every send.
  Tamper: goods released twice (T67).
- **Herald.** `h/tickets.json` gains `escrows`: open and settled escrows
  with both items and the goods still owed per side; a swap rewrites the
  lots' holders.
- **Relay (profile 4).** OpenEscrow: rent(Escrow); AcceptEscrow,
  CancelEscrow: 0; WithdrawEscrow: a caravan's cost.
- **Web.** Escrows naming the viewer: accept, cancel, collect.

## 9. For the owner: choices this contract makes

1. **Accepting is the taker's deposit and the swap at once.** No state
   where both sides are in but not swapped.
2. **Anyone may cancel an open escrow after its deadline**; the maker any
   time before acceptance.
3. **Delivery rights stay in the escrow** (not a tradeable ticket in 2e).
4. **A lot goes whole**: split it first (GiveLot to oneself).
5. **Held goods leave the receipts' roll**: a held ton is promised, so it
   is not reserved for receipts too.
6. **The deadline** is at most 7 days ahead [phase 6].
7. **A lot offered is not checked for validity at opening** (its issue and
   source are not passed): the taker sees the lot in the feed (void or
   not) before accepting.
8. **One counter** (`Citizen.LOTS`) numbers a citizen's lots and escrows.

## 10. Known limits

Reviewed 2026-10-24 by three independent reads; fixed: the amount cap,
the wanted lot's units, the collection and the cancel rolling before they
release a hold, acceptance of goods voided by a seizure, the escrow mark
(`seq` no longer collides with `seq + 1`), and **the vault's stamp**: a
goods side records the low 32 bits of its vault's `BUILT_TS` (side offset
76), so a vault seized, closed and built again (generation 1 again) never
revives old owed goods or releases another escrow's hold. The verifier
also refuses a cancel naming another vault or lot than the escrow's.
Left:

- **A held vault's generation is a u8**: after 256 seizures of one vault
  (it keeps its stamp) an owed side would look live again; not a
  realistic path in a season.
- **Owed goods have no time limit**: a receiver that never collects keeps
  the giver's goods held until a seizure. [proposal for 2f: a collection
  deadline.]
- **A lot handed over keeps its day state** (a receipt claim or the runs
  used today travel with it).
- **Session keys may exchange** (decision L7): both parties consent, so a
  stolen session key could swap a citizen's item for a worthless one.
  The wallet stays required for one-way gifts (GiveLot to another).
- **The web cannot yet close a settled escrow whose owed goods are void**
  (the feed carries no vault generation); a client passing the vaults can.
- **Relay rent:** a collection that closes the escrow returns its rent to
  the opener's payer; the relay's drain guard sees that refund.
- **Verifier:** a cancel naming an absent account for the side's vault or
  lot is accepted when the vault is closed (the verifier derives no
  addresses here; V9 ties live accounts to their keys).

