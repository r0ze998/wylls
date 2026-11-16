# Lane C — landSummary / landElsewhere input edges (2026-11-16)

Base: Lane C tip `ca7fcff9` (G1, not yet integrated). Branch: `claude/lane-c-land-inputs-20261116`.
`land.mjs` and `herald.mjs` are **unchanged**: on the normal paths, nothing shows a wrong 0%, a NaN or an exception.
New: `permutation-gateway/test/web-frontier-land-inputs.test.mjs` and this report.

## Contracts read (and pinned by the test)

| Input | Contract | Source |
|---|---|---|
| `env.province.siteMirror` | always 12 records (v1 `rec:SiteMirror x12`, v2 `rec:SiteMirrorV2 x12`), each with u8 `state` and u8 `faction` | `frontier/abi.mjs`, `sdk/frontier/abi-v2-layouts.mjs` |
| account sizes | `decode` throws `WrongSize` on any other length, so no short mirror can be decoded | `frontier/fcodec.mjs` decode |
| `env.province` | `parseEnvelope` always decodes the Province; a missing one throws and is not stored | `frontier/herald.mjs` parseEnvelope |
| `h.site` / `h.p` / `h.q` | u8 / i16 / i16 from `decode('Holding')`. `FS.holdings` is set only to `me.holdings` or `[]` | `herald.mjs` `me`, `controller.mjs` (4 assignments) |
| `h.production` | `[i64;8]` decoded, which `landYieldPerHour` takes as BigInt | abi Holding `PRODUCTION` |
| mirror state for our village | the program writes `STATE_HOLDING` + `faction` when it makes a holding (founding, taking) | `permutation-frontier/src/proc/citizen.rs` (two sites) |
| rule divisor | `sites…holding.is_some_and(g == f)`, and 0 villages gives 0 | `permutation-rules/src/frontier/land.rs` `bonus_bps` |

## Cases checked (test, run on its own: 4 of 4 pass)

- **Not-loaded, no-land and true-zero answers differ.**

  | Province state | Answer |
  |---|---|
  | not loaded | `null` (no line, never 0%) |
  | loaded without `land` | `null` |
  | `land: null` (record refused) | `null` |
  | loaded, nothing claimed | `{claimed: 0, tiles: 1, bonusPct: 0, perHour: 0}`, a true 0% with no per-hour text |

- **Decoded shapes give finite figures:** BigInt production, a u8 site, two villages, the 30% cap, and the far count with full provinces.
- **Shapes the contract rules out** do not throw and give no NaN. No meaning was added for them:
  - a short, missing or null mirror;
  - a site that is undefined, null, a string, fractional, negative or 255;
  - a nation index past 5, or undefined;
  - non-integer production;
  - a negative or fractional bps.

## Why the remaining "0%" cases are not wrong

- The G1 guard (ce62f04f) withholds the line when the envelope does not mirror the active village as its nation's. So whenever a line is drawn for a holding with a site, `villages ≥ 1`.
- `+0%` is drawn only when the record says nothing is claimed, which is the rule's own zero.
- A holding without a site never comes from the page's own path (only decoded holdings).

## Not verified / next conditions

- **Real herald answers** (a live envelope or `/h/me`): not run. No world, server or browser.
- **`siteMirror` in local play and fixture worlds** (`permutation-gateway/screens/*`, the local-play fixture server). They build envelopes from bytes in the same codec, but I did not run them. A fixture that hand-builds `province.siteMirror` outside the codec is the only way to reach the ruled-out shapes.
- **G1b** (a village lost in the same province while the older envelope still counts it) remains open. Per the coordinator, the stamp proposal is **not** implemented: a page-side read counter alone cannot order concurrent old responses or prove the server generations match. An answer would need generation data from the server, such as a slot on `/h/me` compared with the envelope's slot. I have not checked whether that exists.
