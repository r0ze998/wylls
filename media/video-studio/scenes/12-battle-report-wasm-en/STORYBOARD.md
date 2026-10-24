# 12 battle-report-wasm-en (16:9, 45 s, 30 fps, tech)

| t (s) | Beat | Facts |
|---|---|---|
| 0–8.6 | A march reaches a keep tile and clashes; the real client's clash report (assets/ui/report-verified-en, cropped above its verdict line, tagged "Real web client · test fixture data") slides in; the "Verify in this browser" button is highlighted. Title "Every battle report can be recomputed in your browser." | §3 [LOCAL RUN] |
| 8.6–17 | Pipeline: Rules kernel (Rust, no_std) → Solana program (the only judge of outcomes) and → frontier-wasm → Your browser (`resolve_clash()`); public record flows from the program to the browser. "The same rules, running in your browser." | §7 |
| 17–33.2 | Recreated "Proof details" panel (tagged "Recreated view") with the client's six real English step labels (Not checked → Verifying… → Passed); digest comparison (example values); verdict "Match: the outcome recomputed in this browser is the chain's record"; MATCH stamp | §3: six checks, lower Match |
| 33.2–40.6 | Honest card: a recomputation, not an audit; own1 had six passing checks and a lower "Match" while the upper "Unverified" badge was stale | §11.13, §11.18 |
| 40.6–45 | End card (en) | |
