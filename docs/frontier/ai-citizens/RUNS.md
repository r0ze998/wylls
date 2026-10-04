# Wylls AI runs

Append-only. One block per invocation of `citizens/bin/ai-citizens-run.sh`, written before genesis; aborted and failed runs are listed too.
Each block has a heading and a `RUN` line (JSON: `run_id`, `start_unix`, `commitments_sha256`, `configs`, `arm`, `rep`). When a run ends, an `END` line (JSON:
`run_id`, `end_unix`, `status`, `detail`) is appended at the end of the file; a run with no `END` line was aborted or is still running. `report.mjs`
and the A/B table read these two line kinds and nothing else. Every run is local test chain only.

## slice-1 — 2026-10-04T01:12:42Z
RUN {"arm":null,"commitments_sha256":"6d519fc490ebd4ec7d8c033f9083eeedf4cff78f0a1b05fd1253c7dba617df39","configs":{"citizens_config_sha256":"80e4ca17cd81b1214434cacffac949217cd61b7de88e3cc9882991cd1759e3b6","injection_corpus_sha256":null,"seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"92e1c05169cd42656ff0b7d014659185aead7f34ff8fc337b7e7f86f999db56a"},"rep":null,"run_id":"slice-1","start_unix":1791076362}
END {"detail":"stopped before the end","end_unix":1791076453,"run_id":"slice-1","status":"aborted"}

## slice-2 — 2026-10-04T01:17:21Z
RUN {"arm":null,"commitments_sha256":"0393dea9492b7fd4a0064e3e8a6ef6eb88a7aebeaee7f02a01c06c9c5c6cf1c0","configs":{"citizens_config_sha256":"80e4ca17cd81b1214434cacffac949217cd61b7de88e3cc9882991cd1759e3b6","injection_corpus_sha256":null,"seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"63b017bcbdc99cd8515ab795adcf3f1c7661944adbf236451234c1a63ea665e1"},"rep":null,"run_id":"slice-2","start_unix":1791076641}
END {"detail":"the deal failed (see above)","end_unix":1791076705,"run_id":"slice-2","status":"aborted"}

## slice-3 — 2026-10-04T01:19:39Z
RUN {"arm":null,"commitments_sha256":"a9d3c89801c2e21c9302c60e4bc70645809dc65af71cb61cb7b4af882d4ef339","configs":{"citizens_config_sha256":"80e4ca17cd81b1214434cacffac949217cd61b7de88e3cc9882991cd1759e3b6","injection_corpus_sha256":null,"seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"199dda3e186c8e5a6c38296ec2b557b5f92e975db46381e0260d42074c47834a"},"rep":null,"run_id":"slice-3","start_unix":1791076779}
END {"detail":"stopped before the end","end_unix":1791077458,"run_id":"slice-3","status":"aborted"}

## slice-4 — 2026-10-04T01:31:33Z
RUN {"arm":null,"commitments_sha256":"087d2c3f5505a432d9fac0f336caa8e050e9ed6dfd9e419c61745e6ae0a161d3","configs":{"citizens_config_sha256":"80e4ca17cd81b1214434cacffac949217cd61b7de88e3cc9882991cd1759e3b6","injection_corpus_sha256":null,"seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"5f4eef0182feb787ee53fee51266d9db5eeb872781a3a37e3e2739178846b929"},"rep":null,"run_id":"slice-4","start_unix":1791077493}
END {"detail":"stack complete, publication written","end_unix":1791082735,"run_id":"slice-4","status":"complete"}

## smoke-b1 — 2026-10-04T05:35:59Z
RUN {"arm":null,"commitments_sha256":"ba7c076c93be5b3f2a4ff4ee4afdc869b94f8b99cce8ed3328f8a73495a340fa","configs":{"citizens_config_sha256":"96081d5efdc3f225b0f7ae600bd3984ba170fee6cfd176375543182c19587b3d","injection_corpus_sha256":"5626f53de1a55e72a688a6e19ddcf3aa1234679978d6da6d0ff0b3ad8c50026b","seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"a6a4f3b52eae0386199bd60b602d5ec41223e01e4fab170d04e64420a0808bc2"},"rep":null,"run_id":"smoke-b1","start_unix":1791092159}
END {"detail":"stopped before the end","end_unix":1791092189,"run_id":"smoke-b1","status":"aborted"}

## smoke-b2 — 2026-10-04T05:36:51Z
RUN {"arm":null,"commitments_sha256":"28341d33218fe41cd751778775e727da4ebc6fd272b8cb6b8702bfbb63b2931c","configs":{"citizens_config_sha256":"96081d5efdc3f225b0f7ae600bd3984ba170fee6cfd176375543182c19587b3d","injection_corpus_sha256":"5626f53de1a55e72a688a6e19ddcf3aa1234679978d6da6d0ff0b3ad8c50026b","seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"fdf2dcb4c54f78e1a105e10b4feb5c6bf9fc98f4580e4848004ced3f9581c383"},"rep":null,"run_id":"smoke-b2","start_unix":1791092211}
END {"detail":"stack complete, publication written; season-end bundle written; verify-minds FAIL","end_unix":1791097514,"run_id":"smoke-b2","status":"complete"}

## smoke-b3 — 2026-10-04T07:09:34Z
RUN {"arm":null,"commitments_sha256":"fed8feb38afb0fc87dbe2e51edc456362f38773a0ca675be76f790db24b30a47","configs":{"citizens_config_sha256":"96081d5efdc3f225b0f7ae600bd3984ba170fee6cfd176375543182c19587b3d","injection_corpus_sha256":"5626f53de1a55e72a688a6e19ddcf3aa1234679978d6da6d0ff0b3ad8c50026b","seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"29d520cd05400f69848ad58894ae27468aa8c46e67b956267552f3c7fbcaf63e"},"rep":null,"run_id":"smoke-b3","start_unix":1791097774}
END {"detail":"stack complete, publication written; season-end bundle written; verify-minds PASS","end_unix":1791103089,"run_id":"smoke-b3","status":"complete"}

## smoke-b4 — 2026-10-04T12:07:17Z
RUN {"arm":null,"commitments_sha256":"89b78f9cdff495f5a65a1d34c7141332ed45cf584ef65e58f783066cb546084c","configs":{"citizens_config_sha256":"96081d5efdc3f225b0f7ae600bd3984ba170fee6cfd176375543182c19587b3d","injection_corpus_sha256":"a56fa2fbccf9501b47399284617db86763220331b16aa9850575118dddaf28cc","seat_script_sha256":"c836d1430c2d8a37bb526ddc10fc6da002034fb541d83bbf22627ab00352c6c1","slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"30fffa9a222a35e86929a40dfcb1fae05c1c875b4d562217808d1eb7647403e2"},"rep":null,"run_id":"smoke-b4","start_unix":1791115637}
END {"detail":"stack complete, publication written (anchors: 97 anchored, 0 gap(s) of 97 closed bells); season-end bundle written; verify-minds FAIL","end_unix":1791121675,"run_id":"smoke-b4","status":"complete"}

## smoke-b5 — 2026-10-04T13:51:55Z
RUN {"arm":null,"commitments_sha256":"9a8dd020d20adf36ad729d09f7fda8b6465fb5ae806f7bc3eb5761313826ff69","configs":{"citizens_config_sha256":"96081d5efdc3f225b0f7ae600bd3984ba170fee6cfd176375543182c19587b3d","injection_corpus_sha256":"a56fa2fbccf9501b47399284617db86763220331b16aa9850575118dddaf28cc","seat_script_sha256":"c836d1430c2d8a37bb526ddc10fc6da002034fb541d83bbf22627ab00352c6c1","slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"4ff2699d128a93369f77c964639cfa1d5e28b0f53130efd49ad2cb8298587b64"},"rep":null,"run_id":"smoke-b5","start_unix":1791121915}
END {"detail":"stack complete, publication written (anchors: 109 anchored, 0 gap(s) of 109 closed bells); season-end bundle written; verify-minds PASS","end_unix":1791127950,"run_id":"smoke-b5","status":"complete"}

## smoke-r1 — 2026-10-04T15:44:42Z
RUN {"arm":null,"commitments_sha256":"49372e07e794d916d66533eae2fdb0c87e11ec3d95b78ac6a96f6fb315f33f85","configs":{"citizens_config_sha256":"96081d5efdc3f225b0f7ae600bd3984ba170fee6cfd176375543182c19587b3d","injection_corpus_sha256":"a56fa2fbccf9501b47399284617db86763220331b16aa9850575118dddaf28cc","seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"3abd4bf5a9aa200c33ae0f36f81a22cda45723a1aada6868f28273970a04f577"},"rep":null,"run_id":"smoke-r1","start_unix":1791128682}
END {"detail":"stack complete, publication written (anchors: 61 anchored, 0 gap(s) of 61 closed bells); season-end bundle written; verify-minds PASS","end_unix":1791131823,"run_id":"smoke-r1","status":"complete"}

## smoke-r2 — 2026-10-04T16:53:55Z
RUN {"arm":null,"commitments_sha256":"a22f3c277c32be30bea7cd02a296ee8bce6434ebfe8bca4d905fc97da08c6d18","configs":{"citizens_config_sha256":"96081d5efdc3f225b0f7ae600bd3984ba170fee6cfd176375543182c19587b3d","injection_corpus_sha256":"a56fa2fbccf9501b47399284617db86763220331b16aa9850575118dddaf28cc","seat_script_sha256":null,"slots_sha256":"e33087069de562cbba0220ca3111340a6039c12cad8501b97029c3d44666ad36","stack_toml_sha256":"c94adc95a6bcf7dd5eb0c195cd7556f42758339c4581704560f0c96fb87a9c4e"},"rep":null,"run_id":"smoke-r2","start_unix":1791132835}
END {"detail":"stack complete, publication written (anchors: 109 anchored, 0 gap(s) of 109 closed bells); season-end bundle written; verify-minds FAIL","end_unix":1791138874,"run_id":"smoke-r2","status":"complete"}
