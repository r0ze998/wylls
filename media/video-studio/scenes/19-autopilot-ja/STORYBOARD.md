# 19 自動運転と、コードに置いた保証 (JA, 16:9, 45 s)

| t (s) | Beat | Source |
|---|---|---|
| 0–5 | 「保証は、コードに置く。」 | |
| 5–10.8 | Gemma spike bars: rule bot 18/20 marches; model 9/20 with the one scoring line, 1/20 without | gemma4/REPORT.md |
| 10.8–16 | 79% valid at best (EN 88 / JA 71); ~5 s per decision; "not stronger than bots" | REPORT.md |
| 16–23 | All moves → code: legal ≤12 → model picks one → code re-checks → program refuses illegal | FACTS §5 |
| 23–31 | Autopilot: economy, duties, Strike Orders when invited; never starts its own march | FACTS §5 |
| 31–40.5 | smoke-b3: 171 actions from AI wallets: 51 in model-chosen steps (29.8%, upper bound), 110 autopilot economy (64.3%), 10 remaining; 52/52 valid, n below the 300 gate | OVERVIEW §6.1 |
| 40.5–45 | End card | |

Badges: spike section labelled as a local lab measurement of the bare model (grey); smoke-b3 section labelled local test chain.
