# 19 Autopilot and guarantees in code (EN, 16:9, 48 s, 30 fps)

| t (s) | Beat | Source |
|---|---|---|
| 0–5 | "Put the guarantees in code." | |
| 5–11 | Spike bars: rule bot 18/20 marches; model 9/20 with one scoring line, 1/20 without | gemma4/REPORT.md |
| 11–18.5 | 79% valid at best (EN 88 / JA 71); ~5 s per decision; not a better player than the bot | REPORT.md |
| 18.5–25.5 | Every move → code: legal ≤12 → model picks one → code checks → program refuses anything illegal | FACTS §5 |
| 25.5–34 | Autopilot: economy, duties, Strike Orders when invited; never starts its own march | FACTS §5 |
| 34–44 | smoke-b3: 171 actions from AI wallets: 51 in model-chosen steps (29.8%, upper bound), 110 autopilot economy (64.3%), 10 the rest; 52/52 valid, n below the 300 gate | DESIGN-OVERVIEW §6.1 |
| 44–48 | End card | |
