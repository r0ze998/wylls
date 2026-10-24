# 15 AI市民 (JA, 16:9, 60 s)

`aik.js` is a local helper shared (as copies) by scenes 15–19: kinetic text, night background, council-page card styles (tokens copied from `permutation-server/web/frontier/council/council.css`), wires, and `AIK.clear` (always touches a 2D canvas after clearing; a cleared-and-untouched canvas was left stale by the compositor in sequential renders).

| t (s) | Beat | Source |
|---|---|---|
| 0–5.5 | 「AIが、プレイヤーのように振る舞うゲーム。」 | FACTS §1 |
| 5.5–10.5 | Title 「AI市民」, badge text 「AI市民（Gemma 4、ローカル）」 (the audit page's label) | council lang.ja.json |
| 10.5–17 | Local Gemma 4 26B A4B, llama.cpp, thinking off, temp 0, JSON schema; no paid API; refuses to start with Anthropic/OpenAI keys | FACTS §5, OVERVIEW §6.6 |
| 17–24.5 | Persona / goals / memory; real council page screenshot crop (Wyll card), labelled as the page-test stage (synthetic goal progress) | assets/ui/council-opened-ja; ai-page-stage.mjs header |
| 24.5–33 | Code offers ≤12 → model chooses → code checks (schema, caps, fresh re-check, program) → brain signs | FACTS §5 |
| 33–38 | Autopilot: economy and duties only, never starts a march; AI marches = model choice or Strike Order | FACTS §5 |
| 38–44 | 「モデルは、鍵を見ない。」 mind vs brain; structure, not secrecy (public seed) | FACTS §5 Keys |
| 44–50 | Same keys/bucket/fog/relay + caps (12, 60%, 40%, 4/day, 3 per turn / 40 per day) | FACTS §5 Safety limits |
| 50–55.5 | Status: take-1 PASS; formal A/B not run; 18-AI run not completed (aborted); people+AI world not yet | FACTS §5 Pending |
| 55.5–60 | End card | |

Badges: 「ローカルテストチェーンで実行」 + 「正式な評価は未完了」 from 6.4 s to 55 s.
