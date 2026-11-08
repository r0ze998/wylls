# Local march demo protocol v1

Status: implemented private local prototype. Exact Rust happy-path and refusal tests validate the bounded scenario; browser integration is tracked separately.

## Boundary

Dedicated private `local_march_demo` process, built only with `local-march-demo`. No wallet, signing, network, chain submission, or arbitrary instruction execution. This session is separate from the existing economy tab. Its optional Train acts on the same holding that owns its march. Initial accounts, enemy resident, public encrypted-key material, and non-arrival beacons are fixtures. Arrival anchor/seed, Depart, Reveal, Gather, Resolve, settlement and Return must run real handlers. No post-action account playback.

The destination is precomputed through bell 19 using real Resolve before initial export; the session then starts its origin clock at bell 6. This is a fixed scenario with a precomputed destination, **not a globally synchronized whole-world simulation from the beginning**. Initial destination scoring/camp/snapshot cursors and chains are therefore ahead of the origin. Every interactive action after this initial state executes live handlers.

## Transport

One printable ASCII command per LF-terminated stdin line, at most 128 bytes. Exactly one JSON response per command, at most 1048576 bytes excluding LF. No other stdout. Fixed binary, no arguments, minimal environment. Never invoke Cargo from a browser request. EOF terminates. Overlong or malformed input refuses without mutation. One command at a time. Host fatal error makes session uncertain; no automatic respawn/retry.

Commands (exact tokens, canonical decimal REV 0..1000000):

- `get`
- `reset REV`
- `depart REV`
- `train REV`
- `settle_departure REV`
- `post_reveal REV`
- `resolve_arrival REV`
- `settle_transit REV`
- `dissolve_return REV`

Train is fixed unit 0, count 10, at most once while phase is `departed`. No client coordinates, paths, account bytes, timestamps, lamports or instruction bytes. Reset reconstructs initial fixtures and increments revision. Get never changes revision. Every successful mutation increments revision once. Refused/fault commands never commit staged account changes or advance revision. Revision overflow refuses.

## Phases and simulated time

`ready` -> depart -> `departed` -> settle_departure -> `travelling` -> post_reveal -> `revealed` -> resolve_arrival -> `resolved` -> settle_transit -> `settled` -> dissolve_return -> `returned`.

Train leaves phase `departed`. Each phase may execute multiple named real instructions atomically in the local command stage. Any failure discards the entire stage.

Fixed Season genesis 1790444847. Depart/Train at bell 6 +60s. Origin settlement at bell 8 +60s. Arrival bell 20, public T round 32551361, S round 32551652. PostAnchor at bell 21 +213s; Reveal at bell 21 +300s. PostSeed/Gather/arrival Resolve at bell 22 +300s. Dissolve and later Resolve/Return follow audited bells 21/22/23 and simulated bell 25 +60s. All times are simulation controls, not wall-clock timers. There is no advance-time command.

## Response schema

All fields below are present. Numbers are nonnegative safe JSON integers unless stated; chain-sized unsigned quantities and signed coordinate/time values are canonical decimal strings. Hex is lowercase, even length, no prefix.

```
{
  "protocol": "wylls-local-march-v1",
  "mode": "local-only",
  "auth": "MOCK_AUTH_NO_SIGNATURE",
  "beacon": "PUBLIC_FIXTURES_REAL_VERIFICATION",
  "session": "separate-march-same-holding-train",
  "status": "ok|refused|fault",
  "error": null,
  "command": "get",
  "revision": 0,
  "phase": "ready",
  "trained": false,
  "allowed": ["depart", "reset"],
  "clock": {"unix": "1790448507", "bell": 6},
  "map": {
    "worldHex": "...",
    "origin": {"p":"129","q":"0"},
    "destination": {"p":"129","q":"-1"},
    "route": [{"p":"129","q":"0","tile":1}],
    "provinces": [
      {"p":"129","q":"0","accountKeyHex":"...","passableMask":"..."},
      {"p":"129","q":"-1","accountKeyHex":"...","passableMask":"..."}
    ]
  },
  "host": {"refHex":"...","originTile":1,"destinationTile":2,"initialMilli":300000,"currentMilli":300000,"transitState":"absent","fate":null},
  "holding": {"accountKeyHex":"...","tile":1,"reserveUnits":600,"escrowLamports":"0","poolOwedLamports":"0","openTransits":0},
  "combat": {"engagements":0,"arrivalSurvivorMilli":null,"enemyFixture":true},
  "returned": {"creditedUnits":0,"creditedMilli":0},
  "evidence": {
    "instructions": [],
    "recordsHex": [],
    "accounts": [{"keyHex":"...","ownerHex":"...","lamports":"0","dataHex":"..."}]
  }
}
```

Example values for tile/reserve above are illustrative; never hardcode them in the UI. Exact route includes every real tile from origin through destination and is derived from fixed public order metadata. Coordinates are province coordinates; tile indices are 0..60. `passableMask` is a decimal u64. `refHex` is the full WideHostRef encoding. Null fate/survivor means not yet resolved. `currentMilli` is read from the live transit or standing entry as appropriate (during Departed, the origin pending Spend entry is authoritative because transit troops_after is not yet settled), never animated interpolation. `transitState` is `absent|departed|settled|closed` (the transit's `settled` means origin departure settled, not destination settlement). Fate is null or a numeric ABI fate code.

`error` is null on success or a bounded fixed ASCII error token on refusal/fault. Allowed lists phase-eligible mutations including reset, and train only if not trained. Get is always accepted. Refusal returns unchanged state evidence and no successful new receipts. `evidence.accounts` is the entire bounded current account set, not client-writable input. `instructions` lists fixed human-readable handler names executed by this successful command; `recordsHex` contains their newly emitted successful PSW1 receipts, in order. Get/reset have no new receipts. All account data/owners/lamports are actual post-dispatch snapshots. No secret material exists in them.

UI must validate protocol labels, enum values, bounds, key lengths, hex, unique account keys, revision progression, phase progression and response size. Use returned route/map and account evidence. Do not claim transaction authentication, real-chain balances, hidden orders, arbitrary routing or SBF validation. Mark the enemy and setup explicitly as fixtures. Do not share balances with the old economy session.
