# 11 troops-stances-ja: 8つの兵種と4つの構え (16:9, 45 s, epic)

Badge ローカルテストチェーンで実行 throughout. Soldier minis are Aster's (units/mobs-v1/cards/0_*).

| t (s) | Beat | Sources |
|---|---|---|
| 0–4.2 | Two characters (stage strips, attack once) flank a fan of soldier cards; 8つの兵種と4つの構え | |
| 4.2–10 | 8つの兵種 grid (kernel order) with JA/EN names | fi18n.mjs UNITS |
| 10–16.8 | Cards regroup into 近接 → 騎兵 → 射撃 → 近接, each 1.5倍; 斥候: 戦わない。となりのマスを探索。 | hud/orderparts.mjs unitGood (client text) |
| 16.8–21.2 | 4つの構え: crop of the real march composer's stance row (scene-march-ja), highlight walks across | assets/ui |
| 21.2–31.4 | 構えにも、三すくみ: 突撃→側撃→迎撃→突撃, 待機の構え 相性なし; 勝った側は、与える損害が2割増える。 | hud/glossary.mjs, screens/practice.mjs:236, permutation-rules/src/frontier/stance.rs WIN_BONUS_BPS 12,000 |
| 31.4–40.6 | 軍は、1種類の兵で組む: counter 100 → 30,000 with a growing host; 槍兵100 = 食料60・鉱石20・金10, 訓練はすぐに終わる; crop of the real training panel | FACTS §3 |
| 40.6–45 | End card | |
