# Maintenance notes: where each fact lives

Written with the refactor on branch `refactor/maintainability` (cut from `frontier/season-complete` @ `adb4ac98`), before the redesign's stage 1 adds instructions, accounts and costs. It says which copy of a fact is the source, which copies are now derived from it, which are only checked against it, and which are still written by hand. Behaviour did not change in that refactor; the last section lists the divergences it found and left alone.

## The sources

| Fact | Source | Derived from it (no hand copy) | Checked against it |
|---|---|---|---|
| Instruction tags, names, keeper class, top-level flag | `frontier-abi/src/tags.rs`, `src/v2/tags.rs` | fclient `abi::tag`, `INSTRUCTIONS(_V2)`; JS `shapes.mjs` tag constants; web `fchainio.mjs` `PLAYER_TAGS` | fclient vectors (`frontier-vectors.json`), `abi-vectors --check` |
| CU and transaction budgets | `frontier-abi/src/budgets.rs`, `src/v2/budgets.rs` | fclient `IxInfo.cu_budget` / `tx_max`; JS budgets (generated) | LiteSVM G1 gates |
| Error codes and names | `frontier-abi/src/error.rs`, `src/v2/error.rs` | fclient `ERRORS(_V2)`, `err::*`; JS errors (generated) | `web-frontier-errors.test.mjs` (the page's texts) |
| Log record kinds | `frontier-abi/src/log.rs`, `src/v2/log.rs` | fclient `kind::*`, `entity::*`, `seal_code::*` | |
| Account layouts (offsets, sizes, magics) | `frontier-abi/src/layout/`, `src/v2/layout/` | fclient `layout::*`, `magic::*`, `size::*`; JS layouts (generated); web `fcodec.mjs` reads the generated tables | `layouts_tile_exactly`, fclient's `END` const assertions |
| Account list of an instruction (order, signer, writable) | `frontier-abi/src/prologue.rs`, `src/v2/prologue.rs` `accounts_of` | the program's `check_accounts`; the verifier's `Ix::account(name)` | fclient builder tests (count, signer, writable) |
| Position resolution over an account list | `frontier-abi/src/prologue.rs` `bounds_in` / `counts_in` / `resolve_in` / `position_in` | the program (`permutation-frontier/src/prologue.rs`), v1 and v2 wrappers | |
| Instruction data bytes | `frontier-abi/src/ix.rs`, `src/v2/ix.rs` | | JS codec against the Rust samples, v1 (`frontier-sdk.test.mjs`) and v2 (`frontier-cq-sdk.test.mjs`) |
| Rule figures the page shows (training price, settler cost, strength weight) | `permutation-rules` (`catalog`, `holding::duplicate_cost`, `laurel::strength_weight`) | | `frontier-abi/vectors/v2/web-rules.json` + `web-frontier-rules-vectors.test.mjs` |
| Resource order in the web client | `permutation-server/web/frontier/resources.mjs` | `fi18n`, `fland`, `hud/rulebook`, `map/board` | `web-frontier-shell.test.mjs` |

Regenerate after changing a source: `cargo run -p frontier-abi --bin abi-vectors` (vectors), `node permutation-gateway/scripts/sync-web-sdk.mjs` (the JS SDK and its web copy), `cargo test -p fclient writes_frontier_vectors` (fclient's vectors, when they change). CI runs each with `--check`.

## Adding a conquest (ABI v2) instruction

What still has to be written by hand, in order. Everything not listed follows from these.

1. **frontier-abi**
   - `src/v2/tags.rs`: the `tags_v2!` row; `Ix::NEW` if it is new in v2; `relay_player_shape` / `relay_settle_shape` if the relay sponsors it.
   - `src/v2/prologue.rs`: its account list in `accounts_of`. Name every account: off-chain readers look accounts up by these names.
   - `src/v2/ix.rs`: the data layout and its `data_len_range` / `fixed_len` / `wire_of` arms.
   - `src/v2/budgets.rs`: the `MC_ROWS` row.
   - `src/v2/error.rs` and `src/v2/log.rs` only if it adds an error code or a record kind.
   - `src/bin/abi-vectors.rs`: a `samples` entry. Then regenerate the vectors.
2. **The program** (`permutation-frontier`): the dispatch arm in `src/lib.rs` (the compiler insists) and the handler under `src/proc/`. Handlers unpack accounts by position (`let [actor, payer, season, …] = accounts`), in the order of step 1's list.
3. **LiteSVM** (`permutation-frontier/svm-tests`): the coverage registry (`src/cover/`, the compiler insists), the tests and the G1 gate.
4. **fclient**: a builder in `src/ix/v2.rs` (accounts in step 1's order; its tests check count and flags). Add a `tag::` constant only if fclient code names the tag.
5. **JS SDK and relay**: run `sync-web-sdk.mjs`. `client/src/frontier/codec.mjs` encodes data from the generated tables, except variable-length data such as FileTicket's and FileOutpost's sites, which it writes by hand. In `src/frontier/shapes.mjs`, `allowanceFor` needs a case if the relay pays rent for it. In `routes/relay.mjs`, add it to the list of shapes that read the Citizen if its allowance depends on the Citizen.
6. **Web client**: `fplay.mjs` `SIGNED_BY` and the builder call; the error texts in `fi18n.mjs` for new codes (a test asks for every code).
7. **Keeper** (only if the keeper sends it): a `WriteSpec` in `keeper/src/conquest.rs` with its tag and class.
8. **Verifier**: its check under `verify/src/checks/`, read accounts with `ix.account("name")`; its codes in `verify/src/codes.rs`; tamper classes if it can be forged.
9. **Herald and watchers** only for a new record kind (`herald/src/conquest.rs`, `citizens/watcher/feed.mjs`).
10. **Bots and agents** if they should use it (`bots/src/cqtx.rs`, `agents/src/cqbehave.rs`).
11. **Docs**: the conquest contract's §5.4 / §5.5 rows.

## Changing a rule figure

A cost, production or weight lives in `permutation-rules` and is part of the ruleset hash (a new season is needed).

- Regenerate the vectors: `web-rules.json` changes.
- `web-frontier-rules-vectors.test.mjs` then fails until the page's copy (`fland.mjs` `trainingCost`, `fconquest.mjs` `settlerCost` / `siteWeight`) is updated.
- The bots' copy is not checked (see below).

## Found and left as it is (each changes behaviour, so it is not in the refactor)

Re-checked on 2026-10-26 against `main` at `79c80684` (branch `maint/night-2026-10-26`); the notes after each item say what that check found.

- **The verifier's `Ix::writes`** (`verify/src/world.rs`) resolves positions with the M1 tables for every tag. A v2-only tag (0xA0+) falls back to the message's writable flag. An instruction whose list v2 changed is resolved against its M1 list.
  - *2026-10-26:* where both tables fit an account count they declare the same writable positions (every v2 tag, 0–64 accounts). Where only v2's fits (the v2-only tags, and Harvest, Train, Dissolve, Explore, Depart and SettleDeparture with v2's extra account), the message flag is used. For the accounts these checks ask about (Holdings), that gives the same answer in a successful transaction: `frontier_abi::prologue::check_flags` refuses a program account listed read-only that the message marks writable. So the fallback is not known to change a verdict; it stays as it is.
- **The stack report** (`stack/src/report.rs`) names and budgets transactions with the M1 table. A conquest instruction shows as `?` with budget 0.
  - *Fixed 2026-10-26* (`report::Table`): a conquest run is named and budgeted from the v2 table, an S1 run with Reveal's S1 limit.
- **The agents' outpost check** (`agents/src/cqbehave.rs` `outpost_check`) maps every refusal but `HoldingsFull` to `OutpostRule`. The program maps the land gate to `Capacity`.
  - *2026-10-26:* `outpost_base` passes `free_sites = open_sites = 1`, so the local check never reaches the land gate and the mapping cannot differ from the program's in practice.
- **The bots' training cost** (`bots/src/ai/brain.rs`, `max_train` and its caller) prices with M1's `catalog::train` in every season. A conquest season charges `train_v2`, where the Horseman line is cheaper. The redesign's stage-1 plan already lists this.
  - *Fixed in stage 1a:* `max_train` takes `agents::rules::Rules` (`train`, `train_v2` or `train_v3` by the season's program version).
- **The web's settle list** (`fchainio.mjs` `SETTLE_TAGS`) is narrower than the relay's v2 settle shapes on purpose: the page sends only SettleExplore and SettleTransit.
- **The conquest contract's §5.4 row for FileOutpost** says 28,000 CU and 640 B; the code has 40,000 and 900. Its §5.5 account list for FileOutpost lists fewer accounts than the code has (11–13). The contract changes only by amendment, so it is left to its owner.
- **`docs/frontier/conquest/design/program.md`** still names 0xA3 SettleFounding (now FileOutpost).
