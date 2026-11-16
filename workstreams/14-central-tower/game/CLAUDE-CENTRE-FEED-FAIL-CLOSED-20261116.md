# WS14 centre feed reader: broken feeds refused, not thrown on (2026-11-16, Claude; static, NOT run)

Branch `claude/ws14-feed-reader-20261116`, cut from the candidate d16048aa. Files: `game/centre.mjs`, `game/centre.test.mjs`,
this report. Nothing was run, syntax-checked or imported; `git diff --check` and reading only.

## Contract (source)
The herald writes `h/caravans.json` as `{v: 1, moving: [...], vaults: [...]}` and `h/structures.json` as
`{v: 1, structures: [...], sightings: [...]}` (`frontier-node/crates/herald/src/caravan.rs` 8–13, 91, 132;
`structure.rs` 15–18, 196, 273, 281). Every `ownerTag` is `owner_tag.to_string()` — a u64 as a decimal string.

## Counterexamples (before), each a throw instead of a refusal
1. `moving` / `vaults` present but not an array (an object, a string): the problem was noted, then
   `(caravans.moving ?? []).forEach` threw.
2. A `null` (or non-object) element of `moving`, `vaults`, `structures`: `m.ownerTag`, `v.p`, `s.p` threw.
3. `structures.structures` not an array: `.forEach` threw.
4. A vault's or a structure's `ownerTag` was never checked: `tagOrder`'s `BigInt(x.ownerTag)` threw for a non-decimal
   string or `undefined` (with two or more items to sort).
5. `sightings` present but not iterable (an object): `for (const s of structures?.sightings ?? [])` threw; a `null`
   sighting threw on `s.tower`.
6. `caravans` / `structures` not an object (a string, a number): read `.v` loosely; now refused as such.

## Change (`feedProblems` only)
A list that is not an array, an element that is not an object, or an `ownerTag` that is not a decimal string (moving,
vaults, structures) is a problem; a present `sightings` must be an array of objects. `centreFacts` already refuses on
any problem, so nothing below it can meet those inputs. Places stay `Number.isSafeInteger` (unchanged; `2 ** 53` is
refused). Accepted as before: the herald's own shapes, a missing `structures` list (empty), no `sightings`, any long
decimal tag (`BigInt` reads it). No rule and no output field changed.

## Boundaries left as they were
- `tagOrder`'s tie-break `(a.seq ?? a.tile ?? 0) - …` with a non-number `seq` gives `NaN` (an unstable order, not a
  throw); not changed (not a crash; the herald writes a number).
- `cargo` stays lenient (a non-array is 0; a non-integer slot is 0), as before.

## Regression (SOURCE ONLY, not run)
Two tests appended to `game/centre.test.mjs`: 23 broken feeds — each must not throw and must be refused with no facts;
and the herald's shapes still read (the fixture, no structures list, no sightings, a u64::MAX tag).

## ⑭ → ⑮: unknown cargo is no longer handed over as known zeros (2026-11-16, static; NOT run)
**Defect.** ⑭'s `slots()` filled a cargo it could not read — missing, null, shorter, a non-integer slot — with zeros,
and `sumCargo` added such slots as 0. ⑮'s adapter (`workstreams/15-coop-outcomes/src/adapters/ws14-centre.mjs`) counts a
transit as cargo **"not given"** unless its `cargoByResource` is exactly 8 non-negative safe integers; ⑭'s zeros made it
read an unknown cargo as a known zero.
**Contract now (⑭ `centre.mjs`).** A cargo is KNOWN only as the herald gives it: exactly 8 non-negative safe integers
(`caravan.rs` writes the 8 slots of the rules). Otherwise the transit's `cargoByResource` and `cargo` are `null`. A known
zero (`[0, …, 0]`) stays a known zero. In the summary, `cargoByResource.{all, inner, concord}` sum the caravans whose
cargo is known; a new `cargoNotGiven: {all, inner, concord}` counts the others per set; `cargoInnerShare` /
`cargoConcordShare` are `null` as soon as one moving caravan's cargo is not known (the part it would carry is not zero:
it is not known). Counts and shares of caravans (`innerShare`, `concordShare`) are unchanged.
**⑮: no change needed.** Its existing `notGiven` rule now sees `null` and counts it; it does not read `t.cargo` or the
summary (it recounts). Its frozen fixture (`scenarios/fixtures/ws14-centre-88cf67c0.json`) and its generator use full
8-slot cargo, so a regeneration gives the same facts.
**Other consumers read.** `game/centre-cli.mjs` uses neither cargo nor the summary.
**Regression (SOURCE ONLY, not run).** In `game/centre.test.mjs`: the 3-slot case that pinned the padding now expects
`null` and a `cargoNotGiven` of 1; added: 13 unknown cargo shapes (missing, null, empty, short, long, string, object,
fraction, negative, unsafe, string slot, null slot, NaN) → `null`, nothing added, shares `null`; a known zero and a full
8-slot cargo read as they are; a mixed set (known summed, unknown counted apart, shares `null`), with ⑮'s rule pinned as
text. No rule, prize or evaluation changed.

## Reverse static review (2026-11-16): what reaches sort, BigInt, `ringOf` and the aggregates

Traced in source only. Nothing was run: no test, no `node --check`, no product import, no browser, server or world.

| Path | Input it uses | Checked by `feedProblems` before use? | Result |
|---|---|---|---|
| `tagOrder` → `BigInt(ownerTag)` | moving / vault / structure `ownerTag` | yes (`tagOk`: decimal string) | no throw |
| `tagOrder` tie-break `a.seq ?? a.tile` | moving `seq`; vault / structure `tile` | `tile` yes; **moving `seq` was not** | **fixed**: a non-number made `NaN` — not an order |
| `ringOf(p, q)` | vault / structure place, moving `provinces` | yes (safe integers) | no throw. An empty `provinces` list makes the transit count as "outside" — a meaning, not a crash. Left as is |
| `byFaction[String(faction)]` | moving / vault / structure `faction` | **no** | **fixed**: `{}` gave a confirmed count under `"[object Object]"` |
| cargo sums and shares | moving `cargo` | `knownCargo` (8 non-negative safe integers, otherwise `null` + `cargoNotGiven`) | missing ≠ 0 (the cargo section above) |
| sightings, `gen` | passed through as given (`?? null`) | object shape only | not aggregated, so no false confirmed value |

**The fix:** `optNat` — a `faction` (moving caravan, vault, structure) or a moving `seq` that is given must be a non-negative safe integer. Absent or `null` is still accepted, because the herald writes `faction: null` when it does not know it.
- No upper bound is added. The herald writes u8 / u32, and this check neither widens nor narrows those contracts. It only refuses what is not a number.
- No `ownerTag` (u64) rule changed.

**Unchanged:**
- schema v1;
- the normal `FEEDS` (still `[]` problems; asserted);
- ⑮'s frozen fixture input: `gen-ws14-centre.mjs` uses integer `faction` / `seq` (read, not run);
- the CLI: it prints the whole JSON, so `null` stays distinct from `0`;
- ⑮'s `notGiven` rule (pinned as text).

**New source-only regression:** `a faction or a moving seq that is not a non-negative integer is refused` covers 8 bad values × 4 places, plus absent and `null` still being read.

**Not verified:**
- every test, old or new, is unrun under the standing stop;
- the semantics of an empty `provinces` list;
- whether ⑮'s frozen fixture regenerates byte-identically (it was not regenerated).

## Who reads `cargo: null` and `share: null` (2026-11-16, source only)

I searched with `git grep` for `cargoByResource`, the share fields, `cargoNotGiven`, `centre.transit`, `centreFacts` and `centre.mjs`.

| Consumer | What it reads | Compatible with `null`? |
|---|---|---|
| A UI (`permutation-server/web/…`) | — | no importer of `centre.mjs` or `centre-facts` was found |
| `centre-cli.mjs` | prints the whole output with `JSON.stringify` | yes: `null` is printed as `null`, distinct from `0` |
| ⑮ `src/adapters/ws14-centre.mjs` | `cargoByResource` per transit | yes: anything other than 8 non-negative safe integers goes to `notGiven`. `cargo` and the two shares are in `NOT_USED`, and the summary is recounted from the facts rather than taken, so an added `cargoNotGiven` key is neither read nor refused |
| ⑮ `test/contract-ws14-centre.test.mjs` + the frozen `ws14-centre-88cf67c0.json` | a frozen output (8-slot cargo, `t.cargo === 80`) | the fixture is frozen, so this change doesn't alter it. A `null` input case is not in ⑮'s test (⑮'s own area; not edited) |
| `CONTRACT.ja.md` §6 | the documented output | **updated**: the shares can be `null`, `cargoNotGiven` is added, and an unknown cargo is `null` (the `centre.transit` row) |

**Stale text in other docs, not edited:**
- ⑭ `README.ja.md` line 343 names `cargoConcordShare` as the measure, without saying it can be `null`. That is a question for the reader, not a contract change.
- ⑮ `docs/08-peer-contracts.ja.md` line 231 and the adapter's header comment still name ⑭'s `sumCargo` (removed in 28618a83). Both are ⑮'s files.

**Not verified:** none of this was run.
