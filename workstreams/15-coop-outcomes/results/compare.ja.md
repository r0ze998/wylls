# 3案の比較（生成：`node bin/compare.mjs`）

各欄：評価期間が閉じた鐘（＊は共同達成で評価期間だけを閉じた。世界はどの案でも終わらない）/ その時点で要塞の規則で先頭の国（賞金ではない。賞金は A の旧経路の互換確認だけで、B・C は未決）/ 共同目標。数字は暫定の置き値での模型の結果で、人間で確かめていない。

| シナリオ | A | B | C | C の判定の理由 |
|---|---|---|---|---|
| boundary-crossing | 480 / n1 / — | 480 / n1 / 達成@280 | 304＊ / n1 / 達成@280 | achieved |
| chapter-no-sabotage | 480 / n0 / — | 480 / n0 / 達成@120 | 144＊ / n1 / 達成@120 | achieved |
| chapter-sabotage | 480 / n0 / — | 480 / n0 / 未達 | 480 / n0 / 未達 | stage_use, seized, seized |
| coalition-exclusion | 480 / n0 / — | 480 / n0 / 達成@85 | 109＊ / n0 / 達成@85 | achieved |
| coop-north-fort | 480 / n0 / — | 480 / n0 / 達成@120 | 144＊ / n0 / 達成@120 | achieved |
| coop-with-sighting | 480 / n0 / — | 480 / n0 / 達成@120 | 144＊ / n0 / 達成@120 | achieved |
| double-spend | 480 / n0 / — | 480 / n0 / 達成@120 | 144＊ / n0 / 達成@120 | achieved |
| late-arrival | 480 / n0 / — | 480 / n0 / 未達 | 480 / n0 / 未達 | stage_inputs, late, stage_completion, stage_use, after_close, after_close |
| roles-midway | 480 / n0 / — | 480 / n0 / 未達 | 480 / n0 / 未達 | stage_use |
| round-trip-wash | 480 / n0 / — | 480 / n0 / 達成@120 | 144＊ / n0 / 達成@120 | achieved |
| rush-clients-laundered | 480 / n1 / — | 480 / n1 / 未達 | 480 / n1 / 未達 | diversity |
| rush-clients-own | 480 / n1 / — | 480 / n1 / 達成@72 | 96＊ / n0 / 達成@72 | achieved |
| rush-solo | 480 / n1 / — | 480 / n1 / 未達 | 480 / n1 / 未達 | diversity |
| sybil-labelled | 480 / n1 / — | 480 / n1 / 未達 | 480 / n1 / 未達 | diversity |
| sybil-unlabelled | 480 / n1 / — | 480 / n1 / 達成@72 | 96＊ / n0 / 達成@72 | achieved |
| unverified-storehouse | 480 / n0 / — | 480 / n0 / 判定不能 | 480 / n0（判定不能） / 判定不能 | stage_inputs, unverified_qty |

選択肢：どのシナリオ・どの案でも、待つ・従う以外の選択肢がない参加者は いなかった（評価期間が閉じた後も、世界の中の選択肢は残る）。
世界：どの行・どの案でも `world.ends` は false（評価期間を閉じても世界は終わらない）。
複数の評価期間をまたぐ確認は boundary-crossing（表は最後の評価期間 W2 だけを示す）と test/continuity.test.mjs、長期は results/long-run.json。
