# Stage 2a: the ticket groundwork (contract)

Design: `docs/design/redesign/20-stage2-play.ja.md` §2 and §5,
`29-remaining-decisions.ja.md` A1–A3, and `32-stage2-build-plan.ja.md`
decisions L1–L9 (adopted 2026-10-24). This contract fixes the accounts,
instructions, records and checks of 2a before the code. It also sketches
how 2b–2e build on them, so that 2a's accounts do not have to change later.
Every number marked [phase 6] is a placeholder.

**Tags.** [proposal] marks a choice this contract makes where the design
left it open. These are listed for the owner in §9.

## 0. Scope

| 2a (this contract) | Later |
|---|---|
| The S2 season: program_version 5, `RULESET_HASH_V4`, relay profile 4 | |
| Issue and Lot accounts (L1) | |
| Issuing receipt and use tickets, with the issue fee (L8) | Share tickets: opening a shared vault, depositing by caravan, withdrawing by caravan (2b) |
| Giving and splitting lots; the signer rule (L7) | Claiming on a receipt ticket by the day, the fill (2c, L5) |
| Voiding by the vault's generation; closing lots | Running a workshop on a use ticket (2d, L4) |
| Records, verifier, herald feed, relay | Escrowed exchange (2e, L6) |

## 1. The model

The model, all stages:

- **An issue** is one kind of ticket from one source.
  - Share and receipt tickets come from a **vault**.
  - Use tickets come from a **workshop**, i.e. a holding with workshop
    copies.
  - The issue holds the terms and the total outstanding (`SUPPLY`).
- **A lot** (札の束, L1) is one holder's amount of one issue. Giving a whole
  lot rewrites its holder; no new account is made. Giving part of a lot
  makes a new lot for the recipient, or adds to the recipient's existing
  lot of that issue.
- **Validity follows the source's generation.**
  - The issue and every lot copy the source's `GEN` when made.
  - A seizure raises the vault's `GEN` (1b), and a capture raises the
    holding's `GEN`. From then on, every lot of that source is void.
  - Void lots are not deleted one by one: every use compares
    generations. This is the rule "a seized vault's tickets are void".
- **Goods never move except by caravan** (L3, L6). A ticket is a right to
  send a caravan out of someone else's vault (shares, receipts, 2b/2c), or
  to convert goods inside one's own vault (use, 2d).
- **Shares (2b, L2)** are counted in value units by a fixed table. A
  withdrawal takes a cut of every store in proportion (a basket). Shares
  are a direct fraction of the vault, with no payouts accruing to them.
  So the rule "settle at every transfer" holds by construction: there is
  nothing to settle.

## 2. Accounts

Both are ABI v2 chained accounts (64-byte header), created with
`init_with_seed` by the Season PDA and funded by the relay's payer.

### 2.1 Issue (kind 23, entity kind 13, seed `ti` ‖ issuer_tag u64 ‖ seq u32; 256 B)

| Field | Off | Type | Meaning |
|---|---|---|---|
| KIND | 64 | u8 | 1 share, 2 receipt, 3 use, 4 delivery (one-time receipt from an exchange, 2e) |
| STATE | 65 | u8 | 1 live, 2 closed |
| SRC_KIND | 66 | u8 | 1 holding (use), 2 vault (share, receipt, delivery) |
| SRC_GEN | 67 | u8 | The source's `GEN` when issued |
| P, Q | 68, 70 | i16 | The source's Province |
| AT | 72 | u8 | A holding's site, a vault's tile |
| RESOURCE | 73 | u8 | Receipt: the resource (0..8); otherwise 0 |
| RSV_74 | 74 | 2 | |
| SEQ | 76 | u32 | `Citizen.ISSUES` of the issuer at issue |
| ISSUER_CITIZEN | 80 | [u8;32] | |
| ISSUER_TAG | 112 | u64 | |
| SUPPLY | 120 | u64 | Units outstanding (the sum of its lots' `AMOUNT`) |
| PER_UNIT | 128 | u64 | Receipt: milli of `RESOURCE` per unit per day. Use: runs per unit per day. Share: 0 |
| UNTIL_DAY | 136 | u32 | Last day the tickets may be used; `0xFFFFFFFF` = no end |
| CREATED_BELL | 140 | u32 | |
| PERIOD | 144 | 48 | 2c's daily claim state, zero in 2a (`DAY u32, CLAIMED u64, PREV_DAY u32, PREV_CLAIMED u64, PREV_FILL_BPS u16`, reserved) |
| RENT_TO | 192 | [u8;32] | Rent refund at close |
| RSV | 224 | 32 | |

### 2.2 Lot (kind 24, entity kind 14, seed `tl` ‖ holder_tag u64 ‖ seq u32; 192 B)

| Field | Off | Type | Meaning |
|---|---|---|---|
| ISSUER_TAG | 64 | u64 | With `ISSUE_SEQ`, names the issue |
| ISSUE_SEQ | 72 | u32 | |
| KIND | 76 | u8 | Copied from the issue |
| SRC_GEN | 77 | u8 | Copied from the issue |
| STATE | 78 | u8 | 1 live, 2 closed |
| RSV_79 | 79 | 1 | |
| HOLDER_CITIZEN | 80 | [u8;32] | |
| HOLDER_TAG | 112 | u64 | |
| SEED_TAG | 120 | u64 | The first holder's tag (the seed's), kept when the lot is given whole |
| SEQ | 128 | u32 | The seed's sequence: `Citizen.LOTS` of whoever made the lot |
| DAY | 132 | u32 | 2c/2d: the day of `DAY_AMOUNT` |
| AMOUNT | 136 | u64 | Units of the issue |
| DAY_AMOUNT | 144 | u64 | 2c: claimed that day. 2d: runs used that day |
| ESCROW | 152 | u64 | 2e: the escrow holding this lot, 0 if none |
| RENT_TO | 160 | [u8;32] | |

The seed is `SEED_TAG ‖ SEQ`: the tag of whoever made the lot (the issuer, a
splitting holder, or a giver making the recipient's first lot). A whole-lot
gift keeps the address and rewrites `HOLDER_*`. Readers find a holder's lots by the herald's feed
(§4.4), not by deriving addresses.

### 2.3 Citizen v2 (from `RSV_348`)

`ISSUES @348 u32` and `LOTS @352 u32`: the counters that seed the next
issue and lot. `RSV` shrinks to 28 bytes.

### 2.4 Limits [phase 6]

- `MAX_OPEN_ISSUES = 8` live issues per citizen (counted in the herald and
  verifier; the program counts a live-issue byte, `OPEN_ISSUES @356 u8`).
- `ISSUE_FEE = [0, 0, 0, 0, 0, 20, 0, 0]` units (gold), paid from one of the
  issuer's holdings and **burned** (L8).
- `MAX_SUPPLY = 1_000_000` units per issue.

## 3. Instructions (tags 0xC0–0xC2; 0xC3–0xCF reserved for 2b–2e)

All are player shapes. Accounts follow the v2 prologue `[actor s] [payer
s,w] [season r] [citizen w]`.

### 3.1 IssueTickets (0xC0) — `kind u8, resource u8, amount u64, per_unit u64, until_day u32`

Accounts: P + `[pay_holding w] [pay_province r] [source w] [source_province r]
[issue w] [lot w] [system]`.

- `kind` is 2 (receipt) or 3 (use). Share issues are opened by 2b's
  `OpenShares`, and delivery issues by 2e's exchange.
- **Source:**
  - A receipt needs a live vault the citizen owns.
  - A use ticket needs a final holding the citizen owns with at least one
    workshop copy (`arms::ITEM_WORKSHOP`).
  - In both cases the source must be in its current generation.
- **Terms:**
  - `1 ≤ amount ≤ MAX_SUPPLY`.
  - Receipt: `resource < 8` and `1 ≤ per_unit ≤ vault CAP`.
  - Use: `per_unit ≥ 1`. The daily cap of copies × 24 runs binds when
    runs are used (2d), not here.
  - `until_day` is `0xFFFFFFFF`, or not before today.
- **Fee:** `ISSUE_FEE` is paid from `pay_holding` (any holding of the
  citizen) and burned. `Insufficient` if short.
- **Limit:** refused with `TicketLimit` beyond `MAX_OPEN_ISSUES`.
- **Effect:**
  - The issue is created (`SEQ = Citizen.ISSUES`) and `ISSUES` is raised.
  - The first lot (the whole `amount`) is created for the issuer, and
    `LOTS` is raised.
  - `SUPPLY = amount`.
- **Signer:** the session key may sign (it is the citizen's own act).
- Record `TICKETS_ISSUED` (§4.1).

### 3.2 GiveLot (0xC1) — `amount u64`

Accounts: P + `[lot w] [issue r] [recipient_citizen r] [to_lot w] [system]`.

- `lot` is live, held by the citizen, not in an escrow, and not void. A
  void lot is one whose `SRC_GEN` differs from the issue's source today;
  the program reads the source's `GEN` through the issue's place, so the
  source account is passed too (`[source r]`, appended).
- `1 ≤ amount ≤ lot.AMOUNT`.
- **Recipient:**
  - If the recipient is the citizen itself, this is a split: `to_lot` is
    a new lot (seed: the citizen's `LOTS`).
  - Otherwise `to_lot` is either the recipient's existing live lot of
    the same issue (added to), or a new lot seeded by the **giver's**
    `LOTS`, whose holder is the recipient. A seed names the first
    holder, and the giver pays (§2.2).
  - A whole-lot gift (`amount = lot.AMOUNT`) to a recipient with no lot
    of the issue passes `to_lot = lot`: the holder is rewritten in place.
- **Signer (L7):** a gift to another citizen needs the **wallet**, as a
  send to another player does (`WalletRequired`, 1b §3.3). A split may be
  signed by the session key. Exchanges go through 2e's escrow, which the
  session key may sign.
- An emptied lot stays at `AMOUNT 0` until it is closed (§3.3).
- Record `LOT_MOVED`.

### 3.3 CloseLot (0xC2)

Accounts: P + `[lot w] [issue w] [source r] [rent_to w]`.

- The holder may close a lot that is empty or void.
- Closing a void lot with units lowers the issue's `SUPPLY` by them.
- Rent goes to the lot's `RENT_TO`.
- The issuer may also close its own issue here once `SUPPLY = 0`, or once
  it is void: pass the issuer's own last lot, or `lot = issue` when no
  lot is left [proposal]. The issue's rent goes to its `RENT_TO`, and
  `OPEN_ISSUES` is lowered.
- Record `LOT_CLOSED`.

## 4. Verifier, records, herald, relay

### 4.1 Records (S2, `log.rs`)

| Kind | Payload |
|---|---|
| `TICKETS_ISSUED` | issuer_tag u64, seq u32, kind u8, src Place (16), amount u64, per_unit u64, until_day u32, resource u8, lot_seq u32, fee digest [u8;8] |
| `LOT_MOVED` | issuer_tag u64, issue_seq u32, from (holder_tag u64, lot key), to (holder_tag u64, lot key), amount u64, whole u8 |
| `LOT_CLOSED` | issuer_tag u64, issue_seq u32, holder_tag u64, lot key, amount u64, void u8, issue_closed u8 |

A lot key is `(first_holder_tag u64, seq u32)`, the seed's.

### 4.2 Verifier (`verify`, check V26 tickets)

The verifier replays the records over the accounts it reads. It checks:

- Supply: every issue's `SUPPLY` equals the sum of its live lots.
- Generations: lot and issue generations match the record that made them,
  and no lot of a void issue was moved after the source's generation
  changed.
- Fees: the fee was taken (the holding's stores) and burned (not
  credited anywhere).
- Gifts: every gift to another citizen was wallet-signed.

Tamper detections: a supply change without a record, a lot moved without
its holder's signature, a void lot moved, a fee credited instead of
burned.

### 4.3 Digests

Issue and Lot are chained accounts. Their event chains extend the
citizen's digest as other S1 accounts do.

### 4.4 Herald

`h/tickets.json`:

```json
{"v": 1,
 "issues": [{issuerTag, seq, kind, src: Place, resource, perUnit, untilDay, supply, state, void}],
 "lots": [{key: [firstHolderTag, seq], issuerTag, issueSeq, holderTag, amount, state, void}]}
```

It is folded from the records. `void` is computed from the source's
current generation, which the herald already follows for vaults (1b) and
holdings.

### 4.5 Relay (gateway)

- The relay sponsors IssueTickets, GiveLot and CloseLot under **profile 4
  (S2)**.
- Allowance:
  - IssueTickets: `ISSUE_RENT + LOT_RENT`.
  - GiveLot: `LOT_RENT`. A whole-lot gift and an add-to move nothing, and
    the drain guard sees the real amount.
- `lamportsPerDay` adds one issue and four lots per day [proposal].
- GiveLot to another citizen is a **wallet** shape (as a SendCaravan to
  another player).

### 4.6 Budgets [to be measured]

CU and loaded limits are measured in LiteSVM, as in 1b–1e.

## 5. The S2 season (L9)

- `PROGRAM_VERSION_S2 = 5`. The program refuses other versions, as S1
  refuses 3.
- Kernels are unchanged. `RULES_VERSION` stays 12.
- `RULESET_HASH_V4 = sha256(V3 inputs ‖ ticket::write_tables)`.
  `ticket.rs` holds `TICKET_VERSION`, `ISSUE_FEE`, `MAX_OPEN_ISSUES`,
  `MAX_SUPPLY` and, for 2b, the value table (`SHARE_VALUE`).
- The gateway and the web client add profile 4. It reads the ABI v2 lists
  as profiles 2 and 3 do, with S2's loaded limits. `isV2` covers 2–4.
- Every S1 reader that tests `program_version >= PROGRAM_VERSION_S1` keeps
  working, so an S2 season plays all of S1.

## 6. Tests

- `permutation-rules`: `ticket.rs` tables and the term checks.
- `frontier-abi`: layouts, seeds, records, round trips, the v4 hash.
- `svm-tests/tests/ticket.rs`:
  - issue a receipt and a use ticket (and the refusals: wrong owner, no
    workshop, terms, fee short, limit);
  - split, give by wallet, give refused by session;
  - give whole in place;
  - add to an existing lot;
  - void after a vault seizure (GiveLot refused, CloseLot frees the
    supply);
  - close an issue.
- `verify`: V26 on the svm test's records, and each tamper.
- Herald: the feed's fold.
- Gateway: the profile-4 classifier and allowances.
- Web: parsers.

## 7. Work order

1. `ticket.rs` and the S2 version and hash.
2. ABI: the layouts, tags, records and errors (`TicketLimit`, `TicketVoid`,
   `TicketTerms`).
3. Program handlers, then the svm tests.
4. fclient builders, verifier V26, herald feed, keeper (none: no duty in
   2a).
5. Gateway profile 4 and the relay.
6. Web: profile 4 in `fplay`/`fs1` and the feed parser. The panels come
   with 2b, when a ticket can do something.

## 8. Simulator

None in 2a. 2b adds shared vaults to the S1 simulator's sends.

## 9. For the owner: choices this contract makes

1. **Delivery tickets are a fourth issue kind** (`KIND 4`, 2e). L6's
   one-time receipt reuses the issue and lot accounts rather than a new
   account.
2. **Lots are found through the herald.** The seed names the first holder,
   so a lot keeps its address when given whole. The cost: a reader cannot
   derive a holder's lots from the holder alone.
3. **The issuer may close an issue** once nothing is outstanding, or once
   it is void.
4. **Relay allowance:** one issue and four lots a day per key, on top of
   S1's.
