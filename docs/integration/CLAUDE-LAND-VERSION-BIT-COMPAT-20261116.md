# Land preview: what a version bit 0x0400 would touch (ABI-ALLOCATION rev 7, condition 1) — Claude, 2026-11-16

Static, read-only survey on the candidate (0dc896f2). Nothing changed in code; the bit is **reserved, not applied**.
The land build reports `0x4804` today (S1 4 | wide 0x4000 | expedition 0x0800), the same as the lane without land.
With the bit it would report `0x4C04` (19460).

## Unaffected (threshold or bit tests that 0x4C04 still passes)
| where | check |
|---|---|
| `permutation-server/web/frontier/onboarding.mjs:93` | `programVersion >= 2` |
| `permutation-server/web/frontier/fcodec.mjs:131` | `programVersion >= 3` |
| `permutation-server/web/frontier/fland.mjs:35,39` | `>= 3`, `>= 4` (training costs, arms) |
| `permutation-server/web/frontier/fs1.mjs` `s1Season` | layoutVersion 2 and `>= 4` |
| `permutation-server/web/frontier/hud/subject.mjs:119–120` | `>= 3` (keeps), `& 0x4000` (expedition cards) |
| `permutation-server/web/frontier/fexpedition-context.mjs:41` | `& 0x4000` |
| `frontier-node/crates/verify/src/conquest.rs:114,120`, `checks/v11_land.rs:661` | `>= 3`, `>= 4`, `>= 2` |

## Exact matches on 0x4804 / "18436" — each must accept the land version (or the land build keeps 0x4804)
| where | what it would refuse |
|---|---|
| `permutation-server/web/frontier/flocalplay.mjs:30,188,223` (`LOCAL_PLAY_PROGRAM_VERSION`) | the local-play page itself (`LocalPlayVersion`) |
| `permutation-server/web/frontier/flocalplay-conquest.mjs:112,146` | local conquest requests |
| `permutation-server/web/frontier/fexpedition-prepare.mjs:27,66`, `fexpedition-depart-prepare.mjs:25` | expedition preparation |
| `permutation-server/web/frontier/hud/hand.mjs` (`program_version === '18436'`) | the preparation section of the inspection card |
| `permutation-gateway/src/frontier/expedition-prepare.mjs:18`, `conquest-prepare.mjs:40`, `expedition-depart-prepare.mjs:26` | the gateway's preparation tools |
| `frontier-node/crates/herald/src/local_play.rs:56,151` | the herald's local-play metadata (`program_version is not 0x4804`) |
| `frontier-node/crates/itest/src/expedition_play.rs:77,88` | the runner (compile-time assert against the wire version) |

## So
Applying the bit is a coordinated change across the page, the gateway, the herald and the runner (the ten files in the table above)
plus a rebuilt and re-pinned program. Until the land preview leaves local TEST-ONLY worlds, keeping `0x4804` is the
smaller risk; the launcher already tells land worlds apart by the runner's own `land_preview` statement
(`runnerLandAgrees`). `frontier-abi-land-allocation.test.mjs` keeps this list honest: it fails if any exact gate named here
moves or disappears, or if the bit appears in the program before this list is revisited.
