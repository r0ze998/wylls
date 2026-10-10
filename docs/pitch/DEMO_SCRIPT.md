# Wylls: demo recording script

**Runs to 2:50; hard limit 3:00.** Narration in Japanese, on-screen captions in English. Everything shown is this build: a local test chain and test USDC. The 10-minute step is always a **turn** (ターン) in narration and captions.

**Fixed corner label, on every frame:** `Local test chain · test USDC`

**Time-skip mark:** whenever waiting is cut, show `time skipped` on screen for the whole cut.

**Runs behind the shots**

| Run | What it is | Where it is shown |
|---|---|---|
| `ai-cq-season-3` | The combined season (2026-10-11, code commit `7daf4221`): conquest, prize pool, 6 AI citizens, 6 script bots, 3 paid entries from people's wallets, 96 turns. One wallet was played by hand in the browser; two were driven by `demo-supporter.mjs` through the same browser modules, relay and x402 route. Held after its end with `--hold 7200` | Game `http://127.0.0.1:41940/frontier/frontier/`, council page `http://127.0.0.1:41902/council.html` |
| `ai-cq-demo-1` | An earlier run of this build: 6 AI citizens, 6 script bots, a person. Not shown in the demo | Its files: `.local/frontier/ai/ai-cq-demo-1/` (`report.md`, `pub/`), `.local/frontier/probe/ai-cq-demo-1-*/comparison.md`, `.local/frontier/verify/ai-cq-demo-1-recheck.json` |
| `cq-demo-1` | A person takes the keep of province (4,-1): nation 5 to nation 0 at turn 84 | Game `http://127.0.0.1:41240/frontier/frontier/` (fallback for shot 2) |

## Shot list

| # | Time | Screen, clicks and URLs | Narration (Japanese) | Caption (English) | Source | Record behind the shot |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:08 | Title card: "Wylls: Play the agent economy". Then the game map at `http://127.0.0.1:41940/frontier/frontier/`. Corner label appears and stays. | 「Wylls は、人とAI市民が一つの地図を取り合うストラテジーゲームです。これからお見せするのは、ローカルのテスト用チェーンで実際に動いているものです。」 | People and AI citizens, one map | live | Run `ai-cq-season-3`; the map of the game page |
| 2a | 0:08–0:28 | Normal browser window (the attacker). Open the 国と領土 tab. Click 「届く砦の一覧を見る」. Pick the target keep in the list, click 「進軍を準備」, choose the army, confirm. The composer shows the arrival turn; the destination is sealed. | 「国を選ぶと、すぐに村がもらえます。兵を訓練して、軍を編成しました。届く砦の一覧から、敵の州の砦を選びます。行き先は封印したまま、進軍を出します。」 | A sealed march to an enemy keep | live | Run `ai-cq-season-3`: the attacker's Depart transaction. The march to the keep of province (4,-1) or (0,4). For the script-driven wallet `5ywv9JVH…` the Depart is at turn 19, arrival turn 22, signature `4ZWaC4Qz…` in `.local/demo-supporter/season3-b/transcript.json` |
| 2b | 0:28–0:50 | `time skipped` mark. Same window after the capture. (1) The map: the province's tint is now the attacker's nation. (2) 国と領土 tab: 「支配する州」 for the nation. (3) Click the keep: the panel's 「砦の履歴」 shows the old and the new holder with the turn. | 「砦を72ターン守り抜くと、持ち主が変わります。このシーズンでは、二つの砦が Aster のものになりました。待ち時間は飛ばしました。地図の色が変わり、国の州の数が、9から11に増えました。砦の履歴には、何ターン目に、どの国からどの国へ移ったかが残ります。」 | Held for 72 turns: the keep changes holder · time skipped | held run, time-skipped | Run `ai-cq-season-3`: (4,-1): nation 5 (Fjordal) to nation 0 (Aster) at turn 84, signature `23nX9sYugxWxWW169HAtp91V4MafinKwrcfpuzunAdb4qpozXqk9snLXtG5tEsz8a6jFZDZ44zsJkDEeXLrWRZaP`. (0,4): nation 1 (Borealis) to nation 0 at turn 85, signature `4GLCK5hPVTGajsak9jPHqfpbhMkGS2cftydpnkkocZcEVfKVxauXgehRZrmCqSzdCbQV74aeNMWAhs4ZsFLsf888`. Each after 72 turns of holding (contests from turns 13 and 14). Aster: 9 provinces to 11. The keep panel and the herald's keep record show it |
| 3 | 0:50–1:35 | Council page of the held run: `http://127.0.0.1:41902/council.html#trace=2ba4d645b8` (or open the card of the Ember AI citizen, find the turn-8 decision and click 「この判断を追う」, "Follow this decision"). Scroll slowly through the four steps: (1) what the paying player's wallet did, with the transaction signature; (2) the memory lines shown, each marked; (3) what was chosen, with `by: model`; (4) the result. Pause on the line marked "shown and cited by the model". Then show `comparison.md` in the terminal: the four rows all say c5. | 「次は、プレイヤーの行動がAI市民の判断にどうつながったかを、記録で追います。第7ターンに、参加費を払ったプレイヤーのウォレットが、兵500の軍を出しました。このウォレットはスクリプトで動かしています。この公開の出来事を、コードが別の国のAI市民の記憶の一行にします。第8ターン、そのAI市民が起こされ、モデルが予備の兵を軍に編成することを選びました。画面のとおり、決めたのはモデルで、この一行を引用しています。そこで、この一行を取り除いて同じ問いをもう一度出しました。選ばれた候補は変わりませんでした。違ったのは、モデルが書いた理由の文だけです。」 | A player's march, followed into an AI citizen's decision · by: model · line shown and cited · line removed: choice did not change | held run | Run `ai-cq-season-3`, record `2ba4d645b8db3065d5a8c0a11fbeb68a8d82b2ae6c578b7bfa7bd67d1ad43d36`: public event 1021 at turn 7 (wallet `6oWvAmAJ…`, nation Aster, 500 troops from (2,0)); AI citizen index 1004 (`e9d33ca98a1b4fc6`, nation 4 Ember) woken at turn 8; the model chose c5 (muster, share 50) and cited M2; Muster sent. Comparison `.local/frontier/probe/ai-cq-season-3-2ba4d645b8/comparison.md`: with c5, without c5, control c5, with-again c5 |
| 4 | 1:35–1:55 | (1) The keep panel's history entry, then the herald's keep record in a browser tab, `http://127.0.0.1:41940/h/keep/<p>,<q>.json`: the capture with its `sig`. (2) Terminal: the anchor files of the run, `.local/frontier/ai/<run id>/pub/anchors/`, and the anchored count. (3) Terminal: `pub/verify-minds.json`, the verdict and the list of checks. | 「ここまでの出来事は、すべてチェーンに記録があります。砦の持ち主が変わった取引の署名です。AI市民の判断の記録は、ターンごとにまとめてチェーンに刻んでいます。その記録を、検証ツールで照らし合わせた結果がこちらです。検証ツールは私たちが作ったもので、第三者の監査ではありません。」 | On the chain: signature, per-turn anchors, verify-minds | held run | Run `ai-cq-season-3`: capture signature `23nX9sYugxWxWW169HAtp91V4MafinKwrcfpuzunAdb4qpozXqk9snLXtG5tEsz8a6jFZDZ44zsJkDEeXLrWRZaP`; 121 of 121 closed turns anchored (`report.md`); `verify-minds` PASS on all seven checks as first published (`pub/verify-minds.json`) |
| 5 | 1:55–2:20 | Game page, 賞金（テストUSDC） panel: 「国ごとの州の数（チェーンの集計）」 and the final result line. Then the terminal: `node scripts/prize-settle.mjs … --check` printing the recount per nation. | 「シーズンが終わりました。参加費は25テストUSDCで、8割が賞金プールに入ります。今回は3件で、プールは60です。勝つのは、州を最も多く持つ国です。数えるのはチェーン上のプログラムで、誰でも実行できます。運営が順位を書き込むことはできません。別の手順で数え直しても、同じ結果になりました。」 | Season end: provinces counted on chain · winner by provinces held | held run | Run `ai-cq-season-3`: pool 3 entries, 75 collected, 60 prize, 15 operator. Provinces for nations 0 to 5: 11, 8, 9, 9, 9, 8 (Aster, Borealis, Cinder, Dunmar, Ember, Fjordal); 54 of 54 counted; winner nation 0 Aster; Finalize signature `2cGtWR9TVD1WrAsoZkQ9ydFkXtXNwPLDkwWsuS5XHgAjcHSjrnkXWg3QjucoiFPjDFk5nFnvEsdtf79zCNbRqNmb`. The pool's result, the recount from the province accounts and the herald's control file agree (`.local/prize-settle/ai-cq-season-3/settle.json`) |
| 6 | 2:20–2:42 | Same panel, 「分配の試算」. Show two lines: the attacker (capture) and the supporter (troop reinforcement). Then `ledger.json` in the terminal: the same two lines with their transaction signatures. Keep the page's own estimate notice in frame. | 「勝った国の中で、誰が何をしたかも記録しています。砦を落とした人と、兵を送って支えた人です。どちらの行にも、根拠になる取引の署名が付いています。ここに出ている金額は試算です。今回は25、25、10テストUSDCです。送金はまだ行っていません。配点は暫定です。」 | Achievements with signatures · payout: estimate, no transfer made | held run | Run `ai-cq-season-3`, `ledger.json` and `settle.json` from `prize-settle.mjs`: capture of (0,4) by `4yWQ2bBE…` at turn 85; capture of (4,-1) by `5ywv9JVH…` at turn 84; reinforcement of (4,-1) by `6oWvAmAJ…`, 483 troops on the held keep. 3 of 3 lines re-derived by `--verify`. Estimate with the provisional weights: 25 / 25 / 10 test USDC of the 60. No shares posted, no claim made (`.local/prize-settle/ai-cq-season-3/ledger.json`) |
| 7 | 2:42–2:47 | Architecture card (5 seconds). Boxes with tags: "AI inference (built)", "Action sending (built)", "Relay, game program, prize program (built)", "Stake-check execution service (next, not built)". | 「最後に全体の構成です。ステークを確かめてエージェントを動かす仕組みは、次の段階で、まだ作っていません。」 | Staking for agents: next, not built | card | README, section "Architecture" |
| 8 | 2:47–2:50 | End card: "Wylls" and the repository link. Corner label still on. | （ナレーションなし） | Local test chain · test USDC | card | |

## Fallback for each shot

| # | If the live or held step fails | Say instead |
|---|---|---|
| 1 | Use a still of the map from the held run | No change |
| 2a | Skip the live composition. Show the keep panel on the held run | 「進軍は、行き先を封印して出しました。」 |
| 2b | Show the herald's keep record of the held run, `http://127.0.0.1:41940/h/keep/4,-1.json`, in a browser tab. If the held run is down, use `cq-demo-1` at `http://127.0.0.1:41240/frontier/frontier/` (keep of province (4,-1), nation 5 to nation 0 at turn 84) and change the caption's run to `cq-demo-1` | 「砦の記録です。州 (4,-1) の砦が、第84ターンに国5から国0へ移りました。」 |
| 3 | Show the saved files: the decision under `.local/frontier/ai/ai-cq-season-3/pub/` (`open/`, `minds/`, `memory/`) and `.local/frontier/probe/ai-cq-season-3-2ba4d645b8/comparison.md` | 「ページの代わりに、保存してある記録を見せます。」 The rest of the narration is unchanged |
| 4 | Show the files instead of the pages: the herald's keep record with `sig`, and `verify-minds.json` in a terminal | No change |
| 5 | Show `settle.json` in a terminal in place of the panel | 「画面の代わりに、集計の出力を見せます。」 |
| 6 | Show `ledger.json` in a terminal: the two lines and their signatures | No change; keep 「試算です」 |
| 7 | None needed (a card) | |

## Preparation checklist

The recording is made in segments during **one live season** plus its held state, with `time skipped` marks between segments. A live season takes about 1 h 40 min at 10x.

**Before the season**

1. Start the model server (`permutation-gateway/citizens/llama/start-pinned.sh`), then the combined season with `--hold 7200` ([RUNNING.md, section 4](../RUNNING.md)).
2. Windows. A: a normal browser window on `http://127.0.0.1:41940/frontier/frontier/`, the attacker. B: a private (incognito) window on the same URL, the second person; it gets its own built-in test wallet. C: the council page `http://127.0.0.1:41902/council.html`. D: a terminal in the repository root.
3. Join from port 41940 only. The council page's proxy on 41902 does not forward the x402 payment header yet.

**During the season: what to capture at which turn**

| Turn | Do | Capture for |
|---|---|---|
| 0–1 | In A and B: 「テストUSDCを受け取る」, then join the same nation (the entry fee and the Join are one transaction). Build, train, form an army | Shot 1 (the map), optional join footage |
| by 8–9 | In A: 国と領土 tab, the list 「あなたの軍が届く他国の砦」. Pick a keep from that list (a march can cross at most 4 provinces, so not every keep is reachable). Send the sealed march. In B, or with `demo-supporter.mjs`: march to the same keep to reinforce it | Shot 2a |
| about 8–16 | In C: model decisions of the AI citizens appear. Note the record id of a decision that followed a player's march | Shot 3 can be recorded now or on the held page |
| about 84–86 | Keeps fall (72 turns after the contest began). In A: the map tint, 「支配する州」, the keep panel's 「砦の履歴」 | Shot 2b |
| 96 | The season ends. Wait about 20 minutes for the drain and the publication (`verify-minds` and the report are written) | |

**After the season (held state, up to two hours)**

4. Resume the chain: the stack leaves it paused, and without this the Tally transaction never lands. `curl -s http://127.0.0.1:41910 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"frontier_resume","params":[]}'`
5. In D: `prize-settle.mjs` with `--out` and `--ledger-file`, then `--verify`, then `--check` ([RUNNING.md, section 5](../RUNNING.md)). Reload the prize panel. Record shots 5 and 6.
6. Record shot 3 on the held council page, and shot 4 (the keep record, `report.md`, `pub/verify-minds.json`).
7. Before recording each shot, check that the record named in its last column is what is on screen: run id, turn, signature.
8. **Terminal text.** Some tool output and saved files still print the code's word for the step (the field `bell`). Do not read it out. Crop the line, or keep the caption `turn (field: bell)` on screen while it is visible.
9. No wallet secret or key file on screen.

## Must not say (narration, captions, cards)

- **"bell" or 鐘** for the 10-minute step. It is always turn / ターン. If a field name has to be read out, say "the turn number".
- **Devnet or mainnet** for this build. Nothing here ran there.
- **Real money, USDC without "test", revenue, or "prizes were paid"** for this build. Tokens are test USDC. No prize transfer is shown.
- **That anyone outside the project has played.**
- **Any footage, number or result of the earlier devnet version.** Not the 180 turns, the 14 accounts, the 14 checks, MagicBlock or its prize payments.
- **That the earlier version's agents were language-model agents.** They were rule-based.
- **"The AI decided" without saying who decided.** Say "the model chose" only where the record says `by: model`. Autopilot actions are the autopilot's.
- **That script bots are AI.** They are rule-based test players.
- **"Because it remembered", "it remembered and so…", or any causal wording about memory.** Say "the line was shown" and "cited" or "not cited", exactly as recorded. Never say that memory changed a choice: in the recorded comparisons the chosen candidate did not change. The only allowed sentence is "when the Remembered lines from event 1021 were removed from this 1 logged prompt, the chosen candidate did not change (rerun: same; control: same)".
- **That the model's stated reason is verified, or that the marching wallet in shot 3 was played by hand.** The reason is model-written; that wallet was script-driven.
- **That memory lines are written by the AI.** Code writes them from public records.
- **That staking works, or the name of any currency for staking.** It is "next, not built".
- **That the operator decides the winner, or that the payout is final.** The winner is tallied on chain from province accounts; shares are an estimate; weights, tie-break and fallbacks are provisional.
- **That contribution settlement or the prize transfer is finished.**
- **That AI citizens or script bots can win prizes.** They pay nothing and are not prize-eligible; land they take counts for their nation.
- **That defence or resource supply is recorded.** Neither can be derived from today's records.
- **"Audited" or "independently verified".** The verifiers are ours.
- **That sealed destinations were proven secret, or that live drand was used.** The runs used a test-key beacon.
- **That the season ran in real time or for 14 days.** The clock ran at 10x and the season was 96 turns.

**Optional, earlier version (one sentence, only if wanted, no footage or numbers on screen):** 「以前の版は、devnet で1シーズンを走らせた別のビルドで、今日お見せしたものとは別の記録です。」 Caption: `Earlier version: a separate record`.

**Links:** [README](../../README.md) · [日本語 README](../../README.ja.md) · [Run it](../RUNNING.md)
