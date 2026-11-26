# The devnet world goals judge (off chain, no money) — deploy design

Status: **designed and tested offline, NOT deployed.** Installing it on the live devnet host is a services swap that
needs r0ze's OK (as every herald / gateway / page swap). Owner decisions: 2026-11-26 15:48 JST, Q-PT-6 (c) — show the
goals as "planned — not judged yet" first, then run an off-chain judgement with no money; Q-PT-7 (b) — the flag keeps
are the neutral keeps and Free Cities of the wide land, captured and held for 24 hours.

## What runs where

```
 chain ──(herald's own RPC reads, unchanged)──▶ herald :H   /h/season, /h/world/wide, /h/world/wide/page
                                                   │ loopback only
                                                   ▼
                          node permutation-gateway/src/frontier/devnet-world-goals.mjs --herald http://127.0.0.1:H --dir D
                                                   │ writes D/archive.jsonl (append) and D/answer.json (atomic rename)
                                                   ▼
                          gateway (relay) --world-goals-file D/answer.json      GET /f/goals/state (public listener)
                                                   │
 browser ──▶ tunnel ──▶ herald /gw/f/goals/state ──┘   (the page reads it once a minute)
```

- **No extra devnet RPC.** The judge reads only the herald's public routes on loopback; the herald answers them from its
  fold (the wide Provinces it already captured). The relay reads only a file. The page reads only `/gw/f/goals/state`.
  So the devnet RPC load is exactly what it is today.
- **No key, no signature, no on-chain write, no money.** The judge process opens no key file and has no RPC URL.
  `--herald` must be a loopback URL (refused otherwise).
- **Deterministic and reproducible.** The judge (`src/frontier/wide-flags.mjs`) never reads a clock. Every bell it uses
  is one the captured bytes carry: the keep's `since_bell`, `gen` and `last_taken_from`, and the Province's
  `resolved_next`. `archive.jsonl` holds, for every read, the decoded fields the judge used plus each Province capture's
  slot and sha256. `node src/frontier/devnet-world-goals.mjs --replay D/archive.jsonl --print` rebuilds the served answer
  from the archive alone (byte-equal: test `frontier-devnet-world-goals.test.mjs`). With the herald's or the chain's
  history, anyone can check each recorded capture against its slot and hash.

## The rule as built (`wide-flags-v1`)

| Part | Rule | Open question |
|---|---|---|
| Flags | every keep of an opened wide Province (ring ≥ 129; all start unowned in world 3), and every Free City site (site state 5) the judge has seen | Q-PTWG-1 (which ones count) |
| Hold | a keep held by nation n since `since_bell` s counts once its Province is resolved through s + 144 (`resolved_next ≥ s + 144`). A Province nobody acts in may not be resolved for a long time (seen in the local world-3 replica: wide `resolved_next` 4–7 while the chain was past bell 28), so its hold waits | Q-PTWG-7 |
| Lost before 24 h | a capture by another nation changes holder, `since_bell` and `gen`: the first holder gets nothing | — |
| A hold the judge did not see end | if the next capture names the old holder (`last_taken_from`, `gen` + 1), the old holder's hold is [s, s₂ − 1) and counts if long enough | — |
| Achievement | the first nation to hold a flag 144 turns takes that flag (once per flag) | Q-PTWG-2 |
| Standings | per nation: flags taken, flags held now (not yet taken) | Q-PTWG-3 (is there a "winner") |
| Free City | counted from the first capture that shows it held by a nation (the Province bytes have no capture bell for a site) | Q-PTWG-4; and Q-PTWG-5: **the devnet program cannot capture a Free City** (P14 (b)) |

## Install (later, with r0ze's OK)

1. On the herald/gateway host, from the source tree the gateway runs (a services swap to a commit containing this
   change): `mkdir -p ~/wylls-devnet/world-goals-3`.
2. Start the judge beside the herald (one process, no key):
   `node permutation-gateway/src/frontier/devnet-world-goals.mjs --herald http://127.0.0.1:<herald port> --dir ~/wylls-devnet/world-goals-3 --every-ms 300000`
   under the same supervisor as the herald (restart on exit; SIGTERM stops it between reads). Its log line per read:
   `world goals: read N, bell B, F flags, A achievements`.
3. Restart the gateway with `--world-goals-file ~/wylls-devnet/world-goals-3/answer.json` (or
   `FRONTIER_WORLD_GOALS_FILE`). Until the judge has written an answer the route answers 409 `WorldGoalsNotYet` and the
   page keeps showing the planned card.
4. Swap the page (herald `--web`) to the same commit. Without steps 2–3 the new page shows the planned card only.
5. Check: `curl -s http://127.0.0.1:<gateway public port>/f/goals/state | jq '.ruleset, .judge'`, and the page's
   "Nation & territory" → "World goals" in EN and JA.

Cost: one read every 5 minutes of the herald's wide pages on loopback (≈ 6.5 KB per captured wide Province, at most
256 per page). The archive grows by one line per read: measured ≈ 30 KB per read for 108 wide Provinces (≈ 280 B
each), so ≈ 8.5 MB a day at one read per 5 minutes with that many Provinces.

Rollback: stop the judge, restart the gateway without `--world-goals-file` (the route answers 404; the page shows the
planned card), or roll the page back. The archive stays; a restarted judge replays it and goes on.

A new world (another season) needs another `--dir`: the judge refuses a herald of another season or world against an
existing archive.
