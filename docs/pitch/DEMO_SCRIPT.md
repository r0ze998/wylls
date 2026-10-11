# Wylls demo guide: current seven-scene preview

**Status (2026-10-11):** A silent English-UI editorial preview is assembled at 2:48.167. It has no added title, captions, subtitles, narration or audio. It is **not yet the final uploaded demo**; the final demo URL is pending. The fixed two-minute pitch video and its script are separate from this guide. All scenes below show the actual local test-chain product UI; source footage and the preview are kept outside this repository.

| Scene | Preview time | What the product footage shows |
|---|---:|---|
| 01 | 0:00–0:10 | Six-nation world map in the human-operated `own1` world. |
| 02 | 0:10–0:30 | Village work, 200 Archers trained and a 200-Archer host ordered. This was filmed **later** in `own1`; it is an explanatory preparation shot, not the army used in scene 03. |
| 03 | 0:30–1:05 | Aster seals a 500-Spearman march on Fjordal's keep. The clash report, later capture notice and keep history are shown. There is a hard cut after a **72-turn local-clock advance** at 0:54. |
| 04 | 1:05–1:53.167 | **Separate AI run `take-1`:** Senasha's prior public-event memory, a Gemma 4 model choice and reason, sent march and build transactions, then the linked camp clash and clear. |
| 05 | 1:53.167–2:23.167 | Back to `own1`: clash report and browser recomputation with six Passed checks and a lower `Match` result; keep history follows. The upper `Unverified` badge in this recording is stale. |
| 06 | 2:23.167–2:38.167 | `own1` standings, Aster 10 and Fjordal 8 provinces, and an active **test-USDC** prize panel. The season is still in progress. |
| 07 | 2:38.167–2:48.167 | Changed `own1` map, followed by a separate native product-name shot for the last 2.5 seconds. |

## Run and code provenance

- Scenes 01–03 and 05–07 came from `own1`, season 100, on a **local test chain** served by commit `fa13d486be4a01547eced3bbb8977aad2f106e6f`. This world had no AI personas or bots. The scene-03 clash is at turn 43; occupation was shown after advancing the clock 72 turns, with the keep transferring at turn 110. Scene 02 was recorded after the conquest and is not a continuous setup of that 500-Spearman march. Scene 07's final name shot is another product view, not the next moment in the map.
- Scene 04 came from saved `take-1` at commit `aae47bdbaf0c3c00883ec5d7e7befad0120917dd`: six AI citizens and six script bots, with local Gemma 4. Senasha's turn-65 decision `881d797c0aa5dc3e72951a9d5e946afc845e08de5c5c211da29ccfb5bc256183` records `mode:model` and `reason:ok`. It chose a 400-troop march to a camp and a science build; the saved decision result links the sent transactions to a turn-68 clash and camp clear. `verify-minds.json` reports **PASS** for this run.
- The AI scene is **not** a reaction to the `own1` human action. The council audit page's “Decisions that began with a person’s action” section says “None yet.” It displays earlier clashes that the model cited, but citation does **not** prove those memories caused its choice. The model-written reason is a recorded statement, not verified motivation.
- A separate `take-2` run failed one `verify-minds` item after speech was released early; it is not used in this preview. `take-3` has not started. The video shows neither an adopted council Strike Order nor a completed season winner or payout.

## Disclosure for the final description

State that the footage joins **two different local test-chain runs**. Disclose the 72-turn time advance in scene 03; the silent preview has no on-screen time-skip label. Distinguish the lower browser `Match` result from the stale upper `Unverified` badge that remains visible in scene 05. Describe scene 06 as an active **test-USDC** prize season, with no final payout shown. The current integrated source can start new local worlds through [RUNNING.md](../RUNNING.md); it does not recreate the original ledgers or footage.

The earlier prototype's 180-turn Solana devnet demonstration used **test USDC** and 12 operator-run **rule-based** members among 14 participants; it is not the Gemma 4 run above. The next public season on mainnet with live USDC, a planned 25 USDC entry fee and 80% prize / 20% operator split, remains a plan subject to legal review. Staking is a later idea, not part of this demo.

**Final video URL:** pending. Do not substitute the earlier YouTube link, the 79-second sample-world video, or a local preview path. Add a final link only after the owner provides the uploaded URL and checks the finished video and its description.

**Links:** [README](../../README.md) · [SUBMISSION.md](../../SUBMISSION.md) · [Run locally](../RUNNING.md) · [Design overview](../DESIGN-OVERVIEW.md)
