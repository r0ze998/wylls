# First playable ordinary-wallet version: where it stands (Claude, 2026-11-15)

Ordinary wallets only (a memory-only test key per world). Nothing here is NFT, transfer, session guard, prize, real
funds or public issuance. "Proven" names the evidence and its conditions; "fixture" means the real page on the keyless
screens fixture; a world is a local test world (in-memory chain), never a public one.

## Entry and services (docs/frontier/LOCAL-PLAY-START.md)
- One command starts the launcher (Node 20, built-in modules only): `permutation-gateway/src/frontier/local-play-launcher.mjs`
  on 127.0.0.1:41920. The player opens `http://localhost:41920/` and presses Start a new world.
- Per world the launcher runs: the runner (in-memory chain + keeper; `localnet-natural-play`), the herald
  (`frontier-herald`, the page's records), the relay (Node, one per tab), and calls the depart/preview/resident tools.
- Built from this repository: the program `.so` (scripts/build-frontier-localnet-conquest-sbf.sh, offline, platform-tools
  v1.52), the runners (itest, feature localnet-expedition-play), the herald, the keeper tools. Checked statically
  against this commit's Cargo files on 2026-11-15: every crate, feature, binary, script and toolchain pin the guide
  names exists; the herald and the launcher both know `--herald-output compact-v2`.

## What the first session needs, and its evidence
| step | page | proven where |
|---|---|---|
| start a world, choose a nation, first village placed | Start a new world → Join | live29–live33 (old binaries); fixture |
| train, form a host (held while the province resolves) | Train, Form a host | live23, live33 (old binaries); fixture |
| march, arrival, result collected | March → Send this order; Marches | live29–live33 (old binaries); fixture |
| recover, the same host marches again | host card stamina, "Ready to march" | live32 ×10, live33 ×30 (old binaries) |
| take another nation's fort (area expansion) | March on a keep, hold 72 turns | live33 ×30 one player, 2026-11-14 ×30 two players (old binaries); capture demo only |
| retake after 288 protected turns | — | in-process tests only; not through the page |

## Unverified (each is open; none is claimed)
1. ~~A world on binaries built from the current commit.~~ **Done 2026-11-15 (live34)** for the capture demo at ×30:
   binaries and page built from 5c2dc607 (isolated export, guarded); one ordinary wallet trained, formed a host, marched,
   recovered, marched again with the same host and took another nation's fort (turn 123–129). Record:
   docs/integration/CLAUDE-HEAD-BUILD-LIVE34-20261115.md. Still not shown on those binaries: a natural-speed world.
2. A build and start from a fresh clone on another machine (an empty cargo cache included).
3. The natural world (1×, real time) end to end: a march at 600 s per turn has not been played through on screen in
   this lane (the worlds above were ×10/×30 synthetic).
4. Area expansion for one ordinary player in a natural world: not possible by the rules (a ring opens only at θ
   occupancy of a wedge; heartland keeps never count). Expansion on screen exists only in the TEST-ONLY capture demo.
5. A second human defending or retaking through the page (the 2026-11-14 pair showed a defence breaking the count once).
6. Rounds 33c–46 (page) in a world: live34 showed rounds 43 (Hosts tab while marching) and 46 (the guide stays at the
   march); rounds 44–45 (the test-world box over a notice; the waiting send's notices) did not come up in live34 (every
   send went on its first press).
7. Phone layout (deferred by the owner: PC first).

## Next, in order
1. Done (live34). Next for a first playable version: decide whether the first version is the capture demo (TEST-ONLY,
   compressed) or the natural world (one player: no expansion by the rules); then a fresh-clone build on another machine.
2. Until then: keyless fixture regressions of the first-session path (start → train → form → march), and static checks
   of the guide against the launcher's own usage text.
