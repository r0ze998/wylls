# 23 The replay verifier (EN, 16:9, 45 s, 30 fps, tech)

| t (s) | Beat | Source |
|---|---|---|
| 0–5 | Ledger stream + title "The replay verifier / Replay every transaction. Re-judge every rule." | |
| 5–13 | Ledger docks left; `frontier-stack verify --run-id m1-exit`; V1–V13 checks; counter to 144,300; PASS (verify took 11 s) | runs/m1-exit/verify.md, run.md; FACTS §6 |
| 13–21 | Stream stops on a forged Reveal; T2 "flip a Reveal plaintext byte" → FAIL RevealCommitMismatch → DETECTED | runs/m1-exit/tamper.md |
| 21–29.5 | Grid of all 30 real tamper classes (23 required + 7 extra) flipping to DETECTED; 30/30 | tamper.md, criteria.md |
| 29.5–37 | Bars: m1-exit 144,300; sc-cq2d 32,687; sc-drive 82,037; sc-14d 272,004 — all PASS | FACTS §4, §6 |
| 37–41 | "Our own verifier. Not an independent audit." + command; local test chains only | FACTS §6, §11 |
| 41–45 | End card "Anyone can replay the season." | |
