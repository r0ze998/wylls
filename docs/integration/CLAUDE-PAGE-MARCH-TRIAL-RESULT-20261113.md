# Page march trial (TEST-ONLY, COMPRESSED CLOCK): RESULT — PASS (the page's own march, keeper-settled)

2026-11-13, 17:53–18:19 (26 minutes of wall time).
- **What it is:** a test-only trial on a disposable world. Its clock was **compressed ×5 after the Muster**.
- **What it is not:** natural play, and not `liveProven`. It is kept apart from the natural-start evidence
  (`CLAUDE-NATURAL-TRIAL-RESULT-20261113.md`, natural clock, no march).
- **Scope:**
  - one memory-only world under the launcher, with a 45 min TTL;
  - the page's temporary memory key only, so no real wallet, funds or public chain;
  - loopback ports 41920–41928, and public drand GETs, each BLS-verified;
  - logs kept on the Mac; the world and key gone at the end.
- **Approval:** the user's and supervisor's go in chat (the page march proof within the existing no-real-asset scope).

## Why the clock was compressed, and why that is sound (read from code before starting)
- **Too long for 45 min:** on the natural clock, Muster to settled march takes about 6–7 turns of 600 s, plus a 600 s
  reveal window for each turn the destination lags. That does not fit 45 min.
- **The chain is far behind real time:**
  - the natural runner's chain starts at the fixed g0 (2026-08-01) plus the 25 h announce lead, then runs naturally
    (`natural_play.rs` `genesis_plan`, `await_home`);
  - at the start it was about **103 days behind real time** (chain 1785633793, real 1794559909).
- **Every round needed was already published:** ×5 for the whole TTL adds about 3.75 h of chain time. So every round
  asked for (anchors, T(arrive), seeds) was already public. No round was forged, and BLS verification stayed on
  (`HttpDrand::round`).
- **How:** the node's own `frontier_setScale` RPC (allowed by the memory-only policy) on 127.0.0.1:41924, after the
  Muster landed: `scale 1.0 → 5.0`.
- **No code changed** for this, and no game rule or turn length changed (still 600 chain-seconds).
- **Side effect:** seal secrecy is moot on this world, since the arrival rounds are already public. That is equally
  true of the natural world.

## Binaries and pins
- **Launcher, relay and page:** from **P** (`wylls-playable-20261111`), because the readiness flip below is in P only.
  Launcher options: `--world-preset local-natural-v1 --economy page-signed-v1 --march-trial local-march-trial-v1
  --world-ttl-minutes 45`.
- **Script:** `scratchpad/march-page-trial-run.sh` `5e6afcd6`. It refuses without approval, checks the pins, refuses an
  existing `--data`, and checks ports and disk.
- **Natural runner:** `natural-runner-c2` `692d7952…`, built from the **canonical-equal** composed tree
  (`natural-build-c2.sh` `e3679e80`; `legacy_march.rs` is on its pinned source list).
- **Other binaries:** the herald, the CLIs and the artefact `b64a539a…` as in the natural trial. All pins matched.
- **Readiness in P:** `pageSend: true`, `keeperArrival: true`, `liveProven: false`. The march opens only because the
  page's `march=trial` and the relay's trial capability agree (`localMarchOpen` → `open`, `trial: true`).

## Run
| Time | What | Evidence |
|---|---|---|
| 17:53 | Launcher up; the page opened with `world=natural&march=trial`; "新しい世界を開始" | launcher `prepare "natural 1x"`, TTL 2700 s |
| 17:54 | アステル → "アステルで始める" | `join-landed` faction 0; `place-home-landed` (2, 0) site 10 |
| 17:54 | Train 100 槍兵; Muster 100 at the village tile | page: "全員編成済み" |
| 17:54:37 | `frontier_setScale 5` | status `scale 5.0`; `dataDir null` (memory-only) |
| 17:58 | The keeper formed the host on its own: GatherClash, PostSeed and ResolveFromInputs of bell 0 | page: "最初の軍勢が立った", 槍兵 100 |
| 17:59 | **The page's own march:** 進軍 → 探して選ぶ → 平原 3 tiles away (next to the fort), "守り手なし", arrival turn 4 → **"封をして出発する"** | page: "封をして出発しました。ターン 5 に着きます"; the keeper sees transit slot 0 departed |
| 18:00–18:18 | The keeper, with no player action: | |
| | at the origin: GatherClash, PostSeed and ResolveFromInputs of bell 2 (the departure), then **SettleDeparture(slot 0)** and **Reveal(slot 0, bell 5)** | runner status |
| | at the destination (region 8, untouched since bell 0): PostAnchor plus FastForward for bells 0→5 | |
| | then GatherClash (destination bell 5, from 0 and from 20), PostSeed, **ResolveFromInputs(destination bell 5)** | |
| | then **SettleTransit(slot 0, bell 5)** | signature `2X243e87…` |
| 18:18 | **On the page:** the host stands at the destination; "進軍中の軍勢はいません"; no settle button (13d) | screenshot `(a screenshot kept on the Mac)` |
| 18:19:16 | Ended: SIGINT to my launcher (pid 84798); the tab closed (key discarded) | `stopped.json` `launcher-closing` |

- **On chain** (read-only `frontier_feed`): the test key's five transactions, all `err None`:
  - Join (0x30) `3rG4nDhc…`;
  - PlaceHome (0x38) `2jiSfcxE…`;
  - Train (0x42) `3QdeobS5…`;
  - Muster (0x43) `64SM2bjB…`;
  - **the page's Depart (0x50, 219 bytes) `3vp1ySzJ…`**.
- **No failures:** no refusal, no unknown outcome, no keeper stop, nothing resent.

## Cleanup (verified)
- My launcher (84798) and the world's processes (84914, 85044, 85045) are gone.
- Ports 41920–41933 have no listener.
- The chain was memory-only.
- **Kept:** `<projects>/wylls-launcher-march-trial-20261113/` (6.4 MiB). `runner.out` is `f3b3c121…` and
  `metadata.json` is `439d02fe…`.
- The logs hold no key, seal or salt. The only "private" match is the `/private/tmp` path.
- One process still names the data dir: another session's read-only `sleep 90; cat …/stopped.json`. It is not mine
  and was left alone.

## Finding: catching up an untouched destination costs one reveal window per lagging turn
- **What happened:** the destination province (region 8) had not moved since bell 0. For each lagging turn, the legacy
  driver posted that turn's anchor now and then waited its full reveal window (600 chain-seconds after the anchor)
  before FastForward.
- **Cost:** at ×5 that took about 10 min for 5 turns. On the natural clock it is 10 min per lagging turn, so an
  untouched province N turns behind costs N × 10 min before the march's own turn can resolve.
- **Why the in-process tests did not show it:** they moved the clock with `advance`.
- **Not changed here:** the program and game rules decide this. Possible directions, for review: the keeper anchoring
  every opened province's turns as they end; or checking whether FastForward accepts a range without per-turn windows.

## What this proves, and what it does not
- **Proven, on a compressed-clock test world:**
  - the normal screens take a new player to a **sent march**: the page's own sealed Depart, signed by the page's memory
    key through the trial march route;
  - the keeper settles it to the end;
  - the page then shows the host at its destination and no stale action.
- **Not proven:**
  - natural-clock timing (`liveProven` stays false);
  - a battle: the destination had no defender;
  - **capture.** The page states the existing rule: "砦のマスを 72 ターン続けて保つと、その州はあなたの国のものになります"
    (hold a fort tile for 72 consecutive turns). That is 12 h on the natural clock and 2.4 h even at ×5, beyond the
    45 min limit. Not shortened. A capture test needs a scope decision on time.
