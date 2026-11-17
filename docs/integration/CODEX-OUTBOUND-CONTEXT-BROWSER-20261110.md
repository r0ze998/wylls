# Original map departure context integration

Date: 2026-11-10. This follows commit
`5142351e215ed2700745777e963fe04218cbe81e` on
`codex/wide-conquest-lifecycle-20261109`.

## Player-visible change

The original game's boundary-route card now offers **出発条件を確認**.
It reads the selected host's Season, Citizen, Holding, home/standing Province,
route terrain and Clock together through the existing optional read-only
expedition inspector. The browser checks the exact request, account addresses,
aliases, raw bytes, Clock, and complete snapshot digest before displaying any
result. An absent route Province remains unknown.

The card reports the observed resident/finality/stamina/transit/arrival/fee
conditions and route time from this one response. A successful observation
still says that sending a departure is unavailable. It does not update normal
map accounts, create a march, open a session, build a seal or send a transaction.
Changing the source, route, arrival, timing context or connection discards the
result. Repeated reads, closing the card and captured-terrain reads cancel or
supersede earlier responses.

The route calculation uses the returned exact Clock plus the existing departure
margin. Fractional accelerated rates round that margin upward before converting
to BigInt. Eligibility uses the captured Clock itself; these are distinct
observations, neither an executable future departure verdict.

## Browser evidence

`permutation-gateway/screens/codex-route-preview.screen.mjs` passed all four
selected tests: original-map and boundary-map cases at 1440 × 900 and 390 × 844.
The boundary cases use actual mouse/touch controls in the original game page,
read terrain, then read the new departure context twice. Both viewport cases
confirmed an eligible observation followed by a 73-stamina `Cooldown` refusal.
Each made exactly two explicit snapshot reads. Their key/private/session/server
write logs remained empty, with no external requests or browser errors.

The browser server uses the real read-only HTTP route and request/report
validators with an explicitly synthetic public-account provider. This proves
the original UI wiring and its refusal behavior; it is not live RPC gameplay.
The only allowed non-GET request is the bounded read-only preview POST.

Screenshots were inspected visually:

- `/tmp/wylls-boundary-browser-20261110/desktop-boundary-context.png`
- `/tmp/wylls-boundary-browser-20261110/phone-boundary-context.png`

The mobile card remains scrollable within the original hand panel. The
screenshots are local evidence, not committed assets. Each test closes its own
browser context and ephemeral server; no existing service was stopped.

## Actual Rust read transport

`permutation-gateway/screens/codex-outbound-snapshot.read.mjs` passed its one
explicit integration test using the actual audited native executable:

```text
/tmp/wylls-outbound-context-target/aarch64-apple-darwin/debug/frontier-original-expedition-preview
SHA256 26325b6293c69a5b832414e56310e47e03dc1b8536fe695cf89fb4d25685df9d
```

The real gateway child-process adapter invoked this binary against a temporary
loopback RPC containing synthetic public account bytes. Four requests covered
normal context, absent terrain, a foreign account owner and a mismatched Clock.
Each caused exactly one `getMultipleAccounts`, with confirmed commitment,
`minContextSlot`, and six deduplicated addresses including Clock. The actual
Rust reports passed the gateway and independent browser content-digest parsers.
The two invalid observations were blocked; absent terrain remained unknown.
`keyCalls` was empty. The test closes its adapter and RPC listener in `finally`.

This validates executable transport and cross-language bytes/digests. It does
not authenticate a real RPC, prove current game state, or exercise chain writes.

## Checks completed

There are **109 selected passing tests** in this increment:

| Scope | Passed |
| --- | ---: |
| Browser-side map, composer, route, route-read, context and readiness Node tests | 67 |
| Gateway snapshot and existing inspector tests | 25 |
| Rust outbound snapshot tests | 5 |
| ABI/native terminal cleanup and lifecycle regression tests | 7 |
| Original-page desktop/mobile browser tests | 4 |
| Actual Rust CLI read-only transport integration | 1 |

Node checks used the existing no-key guards. Rust checks used installed Rust
1.95, offline locked dependencies, explicit native arm64 target, two build jobs,
and selected exact tests. The targeted CLI check and build also succeeded.
No full suite, CI, signing, key creation/derivation, new sealing, SBF build,
chain startup or deployment was performed.

Related implementation records:

- [Snapshot request, account set and transport](CODEX-OUTBOUND-SNAPSHOT-20261110.md)
- [Observed departure eligibility](CODEX-ORIGINAL-DEPARTURE-READY-20261110.md)
- [Season-terminal rent cleanup](CODEX-EXPEDITION-TERMINAL-RUNTIME-20261110.md)

## Remaining gameplay boundary

Public dispatch remains closed and the experimental runtime is host-only.
Real departure and return are not playable in the browser. Reverse sealed
movement, live-season bad-seal/nonmember settlement, receipt/indexer admission,
and Solana-target validation remain incomplete. The new terminal writer only
implements the existing aborted/ended/closed Season rule; it does not settle
failed expeditions during a continuously running world. No new outcome or
reward rules have been inferred to bypass these missing contracts.
