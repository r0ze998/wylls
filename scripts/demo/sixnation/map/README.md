# Six nations on one map: a timelapse (TEST simulation only)

Owner feedback on the 9-view grid (t358u): too much text, too many screens. This tool makes **one 1920×1080 map of the
whole world** where you watch the six nations open land, fight over provinces and grow settlements. The only text is the
day, a one-line legend (nation, sigil, provinces held) and a small "TEST simulation" note.

```
(cd frontier-sim && cargo build --release)                  # once: the host simulator (its own small workspace)
npm install --prefix permutation-gateway/screens           # once: playwright-core (Chromium: npx playwright-core install chromium)
scripts/demo/sixnation/map/sixmap.sh --out <new evidence dir> --seed 2002            # ~13 min for 100 s at 30 fps
scripts/demo/sixnation/map/sixmap.sh --dry-run                                         # print the plan, run nothing
```

## Where the story comes from

From `frontier-sim timelapse`. It plays one 7-day season under the **MC conquest rules** (`--rules mc`: keeps, sieges,
occupation, capture, Free Cities, outposts; the `permutation-rules` kernels), with every nation on the **campaign** planner,
bot profile `cq`, 1,000 citizens and 99 % bots. It is the same season `frontier-sim mapmove --rules mc --policy campaign
--bot-profile cq --agents 1000 --bots 0.99 --days 7` plays for that seed: same `Sim::new` and `step` loop, and the trace only
reads the state between bells. A unit test checks the trace changes nothing. The trace is written every 2 bells
(`trace.json`, ~35 MB):

- each province's keep holder;
- each live holding (tile, nation or Free City, tier);
- each army on the march (from, to, nation, troops, sent bell, arrival bell);
- every change of a province's control (`McState::ctl.events`).

**Why not the live local world?** The PR #58 world's operator residents never march (by design of #40's rule). Its 50-turn
recording had **0 captures**: every nation sat on its 5–6 heartland provinces. A one-screen map of that world would show
no territory change. Making the live residents march, seal and siege is a gameplay/bot project of its own, not part of a
recording task.

## What is drawn (`render.mjs`)

- **Terrain**: every opened province's 61 tiles in the client's strategic-view colours (`frontier/map/sprites.mjs FLAT`),
  with the client's hex projection (`web/map.mjs`: pointy-top, y × 0.76). The tile layout is the rules' own
  (`ProvinceCoord::centre`, `geometry::tile_offset`), so provinces have their real ragged outline. New rings rise out of
  the dark sea as they open. There is no centre (⑭): rings 0–1 do not exist, so the middle stays empty.
- **Territory**: each province is washed in its keep holder's colour, `frontier/palette.mjs NATION_FILL`, at 64 %.
  Strong dark lines mark borders between nations, with each nation's own colour just inside. Thin lines separate one
  nation's provinces.
- **Captures**: when a province changes hands, its wash cross-fades to the new nation. A ring opens out in the taker's
  colour, with the taker's sigil (`frontier/map/layers.mjs paintSigil`).
- **Growth**: one dot per settlement, in its nation's colour, larger with its tier (Hamlet → Town → City → Stronghold;
  City and up get a halo). Free Cities are ivory squares. A new settlement pops in.
- **Armies**: a march shows as a trail from its home province to its target, with a diamond head in the nation's colour.
- **HUD**: "Day N" with a season bar (top left), and the legend (bottom).

The camera keeps the empty middle at the centre and zooms out as rings open.

## Output (`--out`)

- `map.mp4`: H.264, yuv420p, 1920×1080, 30 fps, default 100 s. A 1.5 s hold on the first bell, the 7 days at one speed
  (~13 s a day), then a 4 s hold on the last bell.
- `frames/*.png`: stills spread across the video.
- `trace.json`: the season.
- `manifest.json`: seed, options, commit, sha256 of the simulator, the trace and the video, ffprobe, and per-still figures
  (provinces per nation, holdings, armies marching, changes so far).

## Reproducible

The same `--seed` and flags give the same `trace.json`, byte for byte. The simulator's RNG is seeded, with no clock and
no network. The pictures come from the trace alone, so the video repeats too. A different Chromium or ffmpeg build can
change the encoded bytes, but not what is drawn.

## Safety

No chain, no key, no port, no network. The page is served from memory through Playwright's request routing, and every
other request is aborted. Any `--cluster/--rpc/--url/--ws/--key/--keypair/--wallet/--devnet/--mainnet` flag is refused
(exit 3).

---

## 日本語

9画面の録画は「文字が多くて見にくい」との指摘を受けました（t358u）。そこで、**世界全体を1枚の地図（1920×1080）**で見せる
タイムラプスを作りました。6つの国が土地を開き、州を奪い合い、集落を育てていく様子が分かります。文字は日数、
凡例（国名・紋章・保有州数）1行、それに小さな「TEST simulation」の注記だけです。

- 中身は `frontier-sim timelapse` です。MC 征服ルール（砦、攻城、占領、奪取、自由都市、前哨）で7日間のシーズンを1回動かします。
  全国がキャンペーン方針、市民は1000人でそのうち99%がボットです。
  シーズンは同じ seed の `mapmove` とまったく同じで、トレースは状態を読むだけです（変えないことをテストで確認しています）。
- ライブのローカルワールドを使わなかった理由: PR #58 の運営AI住民は進軍しません。50ターンの録画で奪取は0件でした。
  その世界を1画面の地図にしても、領土はまったく動きません。
- 色と紋章はクライアントのもの（`palette.mjs` の NATION_FILL と `paintSigil`）です。地形色も戦略ビュー（FLAT）、
  六角形の描き方も `web/map.mjs` に合わせています。中心はありません（⑭）。
- 同じ seed なら `trace.json` はバイト単位で同じになり、動画の絵も同じになります。チェーン、鍵、ポート、外部への通信は使いません。
