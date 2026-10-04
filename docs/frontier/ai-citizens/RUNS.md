# Wylls AI runs

Append-only. One block per invocation of `citizens/bin/ai-citizens-run.sh`, written before genesis; aborted and failed runs are listed too.
Each block has a heading and a `RUN` line (JSON: `run_id`, `start_unix`, `commitments_sha256`, `configs`, `arm`, `rep`). When a run ends, an `END` line (JSON:
`run_id`, `end_unix`, `status`, `detail`) is appended at the end of the file; a run with no `END` line was aborted or is still running. `report.mjs`
and the A/B table read these two line kinds and nothing else. Every run is local test chain only.

## slice-1 — 2026-10-04T01:12:42Z
RUN {"arm":null,"commitments_sha256":"6d519fc490ebd4ec7d8c033f9083eeedf4cff78f0a1b05fd1253c7dba617df39","configs":{"citizens_config_sha256":"80e4ca17cd81b1214434cacffac949217cd61b7de88e3cc9882991cd1759e3b6","injection_corpus_sha256":null,"seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"92e1c05169cd42656ff0b7d014659185aead7f34ff8fc337b7e7f86f999db56a"},"rep":null,"run_id":"slice-1","start_unix":1791076362}
