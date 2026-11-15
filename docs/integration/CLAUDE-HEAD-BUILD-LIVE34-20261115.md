# A build of canonical 5c2dc607 and one ordinary-wallet world on it (live34, 2026-11-15) — TEST-ONLY

## What this is, and is not
- The binaries and the page are **built from the same commit, 5c2dc607** (unlike live29–live33, which used binaries
  built 2026-11-14 from a snapshot tree).
- The world is the **capture demo (TEST-ONLY): synthetic ×30 clock** (about 20 s per turn), other villages are test
  participants, one ordinary wallet (a memory-only test key), one operator by hand. The 72-turn hold was not shortened.
- It does **not** show a natural-speed world, nor area expansion by one player in a natural world (the rules allow
  neither for one player alone: docs/frontier/LOCAL-PLAY-START.md §4). No NFT, transfer, session guard or prize step.

## The build (14:49–14:51 JST, all exit 0, no guard stop)
- Source: `git archive 5c2dc6074f6a946dd70df42591449666cfad2946` into a new directory (canonical's working tree and its
  uncommitted entries untouched). Fresh targets; `conquest-guard.sh` unchanged (sha 94baeb7d: target ≤ 4 GiB, free
  ≥ 20 GiB, 30 min per step) plus an outer monitor of the two targets' combined size (≤ 4 GiB) and free disk (≥ 21 GiB).
  Peak combined targets 1.40 GiB; lowest free 28.3 GiB.
- Commands: the start guide's (docs/frontier/LOCAL-PLAY-START.md §2): the program through
  `scripts/build-frontier-localnet-conquest-sbf.sh` (offline, platform-tools v1.52, Rust 1.89.0; 30 s); the runners
  (itest, localnet-expedition-play; 61 s), the herald (15 s), the keeper tools (expedition-dispatch-experimental; 10 s),
  Rust 1.95.0.
- SHA-256 (prefixes; full list kept with the evidence): localnet-natural-play bfa9556f…, localnet-expedition-play
  e1774ec7…, frontier-herald d58e7f18…, depart-prepare a9ef3ebe…, preview b3b55318…, resident-prepare ae07d4fe…,
  permutation_frontier.so **b64a539a…** (the same hash this branch's program gave on 2026-11-13: reproduced).

## The world (launcher 14:52:32; world 14:53:17 → TTL end 15:53:17; stopped by me at 15:38)
- `local-play-launcher.mjs` of the same export: natural preset + `--march-trial local-march-trial-v1 --capture-demo
  capture-demo-v1 --demo-scale 30 --herald-output compact-v2 --world-ttl-minutes 60`; loopback 41940 / 41944–41948;
  guard 110 MiB output / free < 21 GiB (never fired; output ≤ 13 MiB at 15:22; world data 38.7 MiB at the end).
- 20 presses, each after a screenshot I looked at (12–38 s), except one disclosed: the Marches tab at 15:13 pressed
  166 s after its screenshot (a read-only tab; it opened Marches).
- One host, id 134144713555968 (the herald's own records, page parser):
  | turn | province / tile | event | stored stamina (@ turn) | ready |
  |---|---|---|---|---|
  | 5–6 | 2,0 / 48 (village) | formed, stood | 120 @ 6 | 6 |
  | 12 | 2,0 / 48 | Depart 1 (Plains, 3 tiles) | 46 @ 13 | – |
  | 14 | 2,1 / 35 | arrived, unopposed | 47 @ 14 | 15 |
  | 47 | 2,1 / 35 | Depart 2 (the same host) onto Fjordal's keep, Province 4,−2 | 7 @ 48 | – |
  | 52–53 | 4,−2 / 4 | arrived, fought (500 → 484), held | 0 @ 52, 1 @ 53 | 55 |
  | 123 | 4,−2 / 4 | the capture turn | – | – |
- On screen (English, 1280×800): Join Aster → Hamlet of Himere placed; Train 500 Spearmen; Form a host; March → "Plains ·
  3 tiles · arrival turn 13 · ready again from turn 40" → "Sealed and on its way. It arrives on turn 14" (one press);
  **round 43 live**: the Hosts tab said "Your host is away on a march. See Marches for its arrival and result." (turn
  15); **round 46 live**: the guide stayed at 4/7 through the march; 49/120 (turn 16) → 63/120 (turn 30, "11") → "Ready
  to march · 75/120" (turn 42); March on a keep → "Fjordal side, ring 4 · 100 defenders · Good · arrival 50" → sent (one
  press, arrives turn 52) → "Your host beat the last defenders of the keep of province 4,−2 and now holds the keep's
  tile (turn 53)" → "Holding the keep · 27/72" (turn 81), "54/72" (turn 107) → turn 129: provinces held Aster 5 → 6,
  Fjordal 6 → 5, the keep under Aster's flag.
- Cleanup by PID: desk quit (contexts and keys gone) 15:38:34 → launcher SIGINT 15:38:37 (stopped.json
  launcher-closing) → guard exited; no world process or headless browser; 0 listeners on 41900–41999; free 28.26 GiB.
- Evidence (scratchpad, sealed SHA256SUMS): rec/live34 (screenshots, desk log, host-entries.txt, guard log, run script,
  build logs, BINARIES.sha256, outer monitor log).

## How a person starts the same world on this machine now (no build needed)
Built binaries: `/Users/r0ze/Projects/wylls-headbuild-5c2dc607-20261115-target-node/debug/`; program:
`/Users/r0ze/Projects/wylls-headbuild-5c2dc607-20261115/permutation-frontier/target/deploy-localnet-conquest-sbf/permutation_frontier.so`;
page and launcher: `/Users/r0ze/Projects/wylls-headbuild-5c2dc607-20261115`. With `ROOT`, `T` (the target's `debug`),
`SO`, `SHA` (b64a539afe066c59c6584ff7928f620647428f1a115df41f9289c772c4447f80) and a NEW empty `DATA` directory:
```bash
node "$ROOT/permutation-gateway/src/frontier/local-play-launcher.mjs" --root "$ROOT" --data "$DATA" --runner "$T/localnet-expedition-play" --natural-runner "$T/localnet-natural-play" --world-preset local-natural-v1 --economy page-signed-v1 --march-trial local-march-trial-v1 --capture-demo capture-demo-v1 --demo-scale 30 --herald "$T/frontier-herald" --depart "$T/frontier-experimental-expedition-depart-prepare" --preview "$T/frontier-original-expedition-preview" --resident "$T/frontier-experimental-expedition-prepare" --artifact "$SO" --artifact-sha "$SHA" --herald-output compact-v2 --world-ttl-minutes 60
```
Then open `http://localhost:41920/` → Start a new world → Choose a nation → Join → Train → Form a host → select the host
→ March (or March on a keep) → Send this order. Stop with one Ctrl-C in the launcher's terminal, then close the tab
(that discards the memory-only key). Without `--capture-demo … --demo-scale 30` it is the natural world: a turn is
600 s and one player alone cannot expand or capture by the rules.
