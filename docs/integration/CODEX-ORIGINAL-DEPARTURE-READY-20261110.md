# Original departure eligibility observations

Date: 2026-11-10.

`permutation-server/web/frontier/fexpedition-ready.mjs` exports the pure
`evaluateOriginalOutboundReady` function. It evaluates a selected original
host against observed Season, Citizen, Holding, standing Province, home
Province and Clock data. Accounts may be exact raw bytes or existing `fcodec`
decoded v2 objects. Clock accepts an exact `unixTimestamp` or its 40-byte raw
sysvar. Unsafe numeric timestamps are refused; i64 arithmetic remains BigInt.

The input contract is:

```js
evaluateOriginalOutboundReady({
  source, season, citizen, holding, province, ownProvince, host,
  clock: { slot, unixTimestamp }, arriveBell, tip, transitSlot
})
```

`source` uses the original composer's public pins and full host identity.
`host` and `transitSlot` are optional: the host is selected from the bounded
standing Province entry table and the slot defaults to the first free slot.
`ownProvince` may be omitted only when the host stands in its home Province.
The context integration passes raw Holding bytes so state-4 bridge markers can
be checked, including the version/reserved bytes omitted by decoded objects.

## Rules and results

The implementation follows `wide_expedition_exec.rs::stage_depart`,
`frontier-abi/src/prologue.rs`, `v2/prologue.rs::capture_locked`, the kernel's
`Host::depart`/`Stamina::at`, and its fee/beacon arithmetic. It checks:

- Configured season/version/ruleset pins, original issuance identity, wallet
  Citizen, matching Citizen inventory slot and Holding owner/generation.
- Home capture lock, stored finality or the actual lazy finality conditions:
  standing at home, final timestamp reached, ticket cohort closed/expired.
- Province resolved through bell minus two, one matching roster entry, no
  pending operation and no matching embedded transit or bridge occupancy.
- Ready bell and 74 available stamina, with the remaining rest bells reported.
- Arrival within the departure stage's actual `[bell + 2, bell + 72]` bounds
  and strictly before the season end, minimum tip, and Citizen action bucket.
- Public `T(arrive_bell)` schedule arithmetic, without producing any seal.

Results include `ok`, the first refusal `code`/`problems`, `nowBell`, `finality`,
`stamina`, `transitSlot`, `arrival`, `minTip`, `bucket` and `sealSchedule`.
Runtime conditions use their corresponding names, including `NotFinal`,
`CapturePending`, `NotResident`, `HostBusy`, `HostInTransit`, `Cooldown`,
`ArrivalBell`, `TipTooLow`, `TransitState`, `Bucket`, `WrongStatus` and
`RulesetMismatch`. Missing or incomplete observations have explicit additional
codes such as `SourceObservationMissing`, `ClockObservationMissing`,
`TransitObservationUnavailable` and `SealScheduleUnavailable`.

## Selected verification

The following single test file passed **9 tests** with both existing no-key
guards. Tests use literal public account observations, public address
derivations and in-memory changes. No fixture signing, private derivation,
sealing, network transport, chain startup, CI or full suite was executed.

```sh
node --import ./scripts/ci/no-keys-guard.mjs \
  --import ./permutation-gateway/screens/codex/no-key-node.mjs \
  --test permutation-gateway/test/web-frontier-expedition-ready.test.mjs
```

| Test | Coverage |
| --- | --- |
| Original source thresholds | Successful observations, exact fee/round values, immutable results and unchanged inputs. |
| Lazy finality | Closed/open/expired cohorts, final timestamp, first-Citizen flag projection and foreign standing refusal. |
| Source substitution | Citizen slot, generation/issuance, wrapping capture generation, duplicate/mismatched host and NFT resident refusal. |
| Resident/pending/transits | Resolve lag, all six pending operations, ordinary transit states, malformed/unknown bridge state and full/selected slots. |
| Stamina/rest | 74 threshold, ready bell, lazy refill, cap and a stored stamina bell ahead of the observation. |
| Arrival/status/tip/bucket | Both arrival bounds, season end, Seeded-to-Running effective status, exact minimum tip, non-preset valid tip and bucket refill. |
| Raw accounts/Clock/bridges | Raw decoding, reserved-byte and origin rejection, same-host lock and unrelated previous-generation occupancy. |
| Exact clocks/schedules | i64 values above 2^53, unsafe Number rejection and missing Clock/beacon fields. |
| Repository rule pins | Source assertions against the Rust finality, residency, pending, stamina, arrival, fee and beacon definitions. |

`git diff --check` passed for the new module and test. The source assertions
detect relevant rule drift; they are not a cross-language runtime equivalence
proof.

## Context integration review and limits

A read-only review compared `fexpedition-context.mjs` and
`inspectOutboundContext` with the evaluator and Rust snapshot serializer.
Request binding, canonical source/route addresses, exact raw Clock/context
slot matching, alias equality, account sorting, digest field order/widths and
the no-Rent marker agree. The integration supplies raw Holding bytes. Response
tokens, aborts and `reconcileOutbound` reject superseded reads and source edits.

The review identified a fractional accelerated-rate case: `departMargin` can
return `90.5`, which cannot be passed directly to `BigInt`. After the finding
was reported, the integrating agent changed the expression to
`BigInt(Math.ceil(departMargin(...)))`; a subsequent source read confirmed that
correction. A noninteger-rate regression case was recommended. This
evaluator/documentation task did not edit or execute that integration code.

Readiness uses the captured Clock time; route evaluation separately uses the
proposed departure time plus margin. Route travel and composer lead policy are
not silently substituted for the runtime departure stage's arrival bounds.
Changing time or account observations requires another check.

`ok` means only that the supplied observations passed these bounded checks.
The result always retains `observationOnly: true`, `executable: false`,
`admitted: false`, `authorityVerified: false` and
`coherentSnapshotVerified: false`; it neither mutates accounts nor certifies a
future transaction. Account authenticity/freshness, signer/session authority,
route travel, beacon authentication and actual seal validity, external-slot
absence, payer funds/rent and public dispatch remain unverified. A decoded
state-4 marker without raw Holding bytes is unavailable, never a free slot.
