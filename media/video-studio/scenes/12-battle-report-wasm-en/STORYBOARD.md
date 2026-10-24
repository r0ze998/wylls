# 12 battle-report-wasm-ja (16:9, 45 s, 30 fps, tech)

| t (s) | Beat | Facts |
|---|---|---|
| 0–8.6 | A march meets a keep tile and clashes; the real client's clash report (assets/ui/report-verified-ja, cropped above its verdict line, labelled 「実際のWebクライアントの画面(テスト用の表示データ)」) slides in; the 「このブラウザで確かめる」 button is highlighted. Title 「戦闘報告は、ブラウザで検算できる。」 | §3 battle reports re-run in the browser [LOCAL RUN] |
| 8.6–17 | Pipeline: rules kernel (Rust, no_std) → Solana program (the only judge) and → frontier-wasm → your browser (`resolve_clash()`); the public record flows from the program to the browser. 「同じルールを、ブラウザの中で動かす。」 | §7 architecture |
| 17–33.2 | Recreated proof panel (labelled 再現イメージ) with the client's six real step labels (screens/report.mjs STEP_TEXT) ticking 未確認 → 確認中 → 済; digest comparison (values labelled 例); verdict 「一致」 with the client's verdict text and a 一致 stamp | §3: six checks and a lower Match |
| 33.2–40.6 | Honest card: recomputation, not an audit; own1 had six passing checks and a lower "Match" while the upper "Unverified" badge stayed stale | §3, §6, §11.13, §11.18 |
| 40.6–45 | End card | |
