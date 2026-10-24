# 15 AI citizens (EN, 16:9, 60 s, 30 fps)

`aik.js` is a local helper copied into each of scenes 15–19: kinetic text, night background, council-page card styles (tokens copied from `permutation-server/web/frontier/council/council.css`), wires, `AIK.remap` (piecewise time map), and `AIK.clear` (always touches a 2D canvas after clearing; a cleared-and-untouched canvas stayed stale in sequential renders). The animated film-grain layer was dropped: it made every frame about 3x slower on the shared render machine.

| t (s) | Beat | Source |
|---|---|---|
| 0–6 | "How does a game behave when AI has a will?" / we don't claim the model wants anything | FACTS §1 |
| 6–13 | Meet an AI citizen: local Gemma 4 26B A4B (no paid API), persona + creed, four goals, memory written by code | FACTS §5 |
| 13–19 | Wyll card on the real council audit page (EN screenshot crop), labelled: page-test stage, goal progress etc. synthetic | assets/ui/council-opened-en; `ai-page-stage.mjs` header |
| 19–35 | Three steps on a **real, verbatim** decision: slice-4, AI "Noe Iby", bell 40: 8 candidate labels → chose c3 (camp march) + c7 (train) → model-written reason (not verified) → cited two build lines ("a citation is not a cause") → checks | `permutation-gateway/test/fixtures/ai-ac9-slice4/state/records.jsonl` record `d75573881ae0…` |
| 35–43 | Autopilot never starts a march; smoke-b3 29.8% / 64.3%; the model never sees keys (structure, not secrecy) | FACTS §5 |
| 43–49 | Same rules plus safety limits | FACTS §5 |
| 49–55 | Still to prove: take-1 PASS; formal A/B pending; 18-AI run pending (one aborted); people + AI together not yet | FACTS §5 |
| 55.5–60 | End card "Play the agent economy." |
