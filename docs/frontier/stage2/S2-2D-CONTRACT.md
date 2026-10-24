# Stage 2d: use tickets (contract)

Design: `docs/design/redesign/20-stage2-play.ja.md` §2 and
`32-stage2-build-plan.ja.md` decision L4 (adopted 2026-10-24). Builds on 2a
(use issues: kind 3, the workshop's holding as source, `PER_UNIT` runs per
unit and day ≤ 24) and 2c (the vault's receipts period). [proposal] marks a
choice this contract makes; they are listed for the owner in §9. Numbers
marked [phase 6] are placeholders.

**Status (2026-10-24):** built — program, ABI, LiteSVM (`tests/uses.rs`;
UseRun 12,546 CU), fclient, verifier (V26 judges UseRun; V7 accepts its
write to the workshop; tamper T66), herald, relay (profile 4) and the web
(one's use lots with the runs left today, "make in my storehouse").

## 0. Scope

| 2d (this contract) | Later |
|---|---|
| `UseRun`: a use-ticket holder converts workshop-hours instantly in its own vault | Escrow (2e) |
| The workshop's daily cap across all its use tickets | The AI (2f) |
| Program, ABI, LiteSVM, fclient, verifier, herald, relay, web | |

## 1. The model (L4)

- **One run** is one workshop-hour of conversion, done at once:
  `arms::WORKSHOP_ORE_PER_HOUR` ore and `WORKSHOP_WOOD_PER_HOUR` wood become
  `WORKSHOP_ARMS_PER_HOUR` arms (8 + 4 → 4) [phase 6].
- **Where:** in the holder's own vault (live, not shared) **in the same
  Province** as the workshop's holding. The materials come from it and the
  arms go into it. Getting materials there is a caravan, as always (A2).
- **The owner loses nothing:** the workshop's own production is untouched.
- **Limits:**
  - per lot and day: `AMOUNT × PER_UNIT` runs;
  - per workshop holding and day, across every use ticket of it: its
    workshop copies × 24 (`arms::workshops_built(production) × 24`);
  - until the issue's `UNTIL_DAY`.
- **Void:** a capture raises the holding's generation and voids its use
  tickets (2a). A holding with no workshop left refuses runs (`UseLimit`).
- The vault's stock changes, so a run rolls the vault's receipts period
  first (2c) and may not use ore or wood reserved for today's receipts.
- The arms must fit under the vault's cap, else the run is refused
  (`BadData`) [proposal]: nothing is lost silently.

## 2. Accounts

### 2.1 Holding (v2): the day's runs, from `RSV_700`

| Field | Off | Type | Meaning |
|---|---|---|---|
| `USE_DAY` | 700 | u16 | the day (+1) of `USE_RUNS` (0: never) |
| `USE_RUNS` | 702 | u16 | runs of the holding's workshops used by tickets on `USE_DAY` |

### 2.2 Lot (2a)

A use lot's `DAY` (+1) and `DAY_AMOUNT` are the day and the runs used on it.

**Gifts carry used runs** (review fix): units given out of a use lot that
ran today take as many of its used runs as they carry (`min(DAY_AMOUNT,
amount × PER_UNIT)`) into the recipient's lot, and the giver's lot keeps
the rest. A split therefore never renews a lot's runs of the day.

## 3. UseRun (0xC8, player) — `runs u8`

Accounts: P + `[lot w] [issue r] [holding w] [vault w]`.

- The lot is the citizen's, live, not in escrow, of a live use issue valid
  now (the holding in the issue's generation), `today ≤ UNTIL_DAY`.
- `1 ≤ runs`; the lot's runs today + `runs` ≤ `AMOUNT × PER_UNIT`, and the
  holding's runs today + `runs` ≤ copies × 24 (`UseLimit`).
- The vault is the citizen's, live, unshared, in the holding's Province.
  Roll (2c); ore and wood available (not reserved) for `runs` hours
  (`Insufficient`); the arms fit under the cap (`BadData`).
- Writes the vault's stores, the lot's day and runs, the holding's day and
  runs (nothing else of the holding).
- Record `USE_RUN`.

### Error

`UseLimit` (100): "the ticket's or the workshop's runs for today are used
up, or the holding has no workshop".

## 4. Record

| Kind | Key | Payload | Chains |
|---|---|---|---|
| `USE_RUN` (111) | issuer_tag u64, seq u32 | holder_tag u64, lot_tag u64, lot_seq u32, day u32, runs u8, lot_runs u16 (after), holding_runs u16 (after), holding_key u64, src Place (8, the vault) | Lot, Holding, Vault |

## 5. Off chain

- **Verifier.** V26 judges UseRun (the limits, the conversion, the roll,
  the counters). V7 accepts a UseRun's write to the workshop's holding when
  only `USE_DAY` and `USE_RUNS` change. Tamper: more arms than the runs
  (T66).
- **Herald.** `h/tickets.json` lots carry `runDay` and `runs`.
- **Relay (profile 4).** UseRun: 0.
- **Web.** One's use lots with the runs left today and a "run" form (the
  vault in the workshop's Province is picked for the viewer).

## 9. For the owner: choices this contract makes

1. **The day's cap is the holding's** (copies × 24 across all its use
   tickets), counted on the holding, so selling more tickets than hours
   only spreads the same hours.
2. **A run that would overflow the vault's cap is refused**, not cut.
3. **Runs respect receipt reservations** in the user's vault (2c), as any
   other removal of its goods.
4. **Used runs travel with gifted units** (§2.2), so a ticket's runs of a
   day stay `AMOUNT × PER_UNIT` however its units are split.
