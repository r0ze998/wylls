# Release evidence for a real TEST-ONLY world on the candidate (Claude, 2026-11-16) — nothing started

Candidate `claude/canonical-candidate-20261116` @ 1b115625 (+ this doc). No world, launcher or deploy was run for anything
below; starting one needs the owner's go (ops: `scripts/play2-land-ops/`, fail-closed). No NFT, transfer, session guard,
prize, real funds or public issuance.

## 1. Proven in a real local TEST-ONLY world (land5, 2026-11-16 00:30–01:42 JST, ×10, two ordinary memory-only wallets)
Page/launcher of `claude/continuous-territory-integ-20261115` @201cc58a (canonical 68e8548d + the land display fix);
runner/herald/.so = the land4 builds (source 9cf2c42a). Shown: a remote enemy land take (4 tiles enemy → own, 3 open
added), the map's colour change (enemy hatched → own solid + gold line), the selected tile's panel owner change, the
chip's home line. Recording and evidence outside git (`wylls-land5-recording-20261116/`).

## 2. Changed since land5 — fixture/unit evidence only, never seen in a world
| change | commit (integration) | evidence |
|---|---|---|
| one block, one sentence on the map; a forming host's tap answers (lane B) | b2fdc645 | march-block-reasons 16/16 |
| S1 promotion ore gain as the program adds it (lane C) | 41fb12a8 | economy-display 10/10 |
| 11 English fixes (lane D) | d3eb9c18 | glossary 16/16 |
| web-lang completeness (b)/(c): return card says ids with L`…` | 5730d50b | web-lang 22/22 |
| return card split into hud/returncard.mjs | 57619f15 | return-card unit 21, screen 2 |
| far land on the chip ("Other provinces: N tiles") | c46b6768 | land-preview tests |
| land yield per hour on the chip | 7e2ecdb9 | land-preview tests (Rust formula pinned) |
| land layer enemy → own; away → arrived (no page change) | 3524adb0, 274bad0d | land-arrival.screen 4/4, 8 runs |
Candidate-only (on top of the WIP bcc63a24): two WIP tests fixed (cfffc589), ABI rev 7 (0xCD/0xCE, 0x4804 kept), the WIP
inventory. Correction kept on record: a `landKeys` product change tried while chasing the land screen's flake was
reverted and never committed — the page painted the land correctly; the test sampled under a sprite (274bad0d).

## 3. Source ↔ binary
| artefact | pinned for play2 (built from) | candidate-built (2026-11-16, guarded, clone target) | relation |
|---|---|---|---|
| land program .so (`localnet-land-sbf`) | f2e644420dd8dca4… (9cf2c42a) | f2e644420dd8dca4a9c985b995ea599040e09b0e69bc561f3069e625e96a5987 | **byte-identical** |
| expedition program .so (`localnet-expedition-sbf`) | — | f2f033281f695e2f8b2fbae88f4e24f9706566aff27a5c014a780f3a8c9ce6f3 | checks pass (build-frontier.sh) |
| `frontier-herald` (`land-preview`) | cd5a9281ab94d00e… (9cf2c42a) | 05a47594cd75b79243d8245afe86827fb160948e59764832fceb59faa5038522 | bytes differ (debug, paths); source differs only by code gated on `expedition-records-experimental` (off) + findex's refusal of a cache written by that feature (a fresh world has none) |
| `localnet-natural-play` (`localnet-land-play`) | f00415a2aa7712fe… (9cf2c42a) | b7420d27797e9417bc32bb5c1468f24b2d429b2aaa4e5177e661100c3945b1b6 | same: itest unchanged, deps' changes gated off |
| `localnet-expedition-play` | e1774ec7a468a1b3… (5c2dc607) | cccb6331c0e1263cf136bffdb1bf92a8d46cf455af0e86d19d6895205f2341a5 | keeper/fclient src unchanged; abi/rules land code gated off |
| keeper depart-prepare / preview / prepare (`expedition-dispatch-experimental`) | a9ef3ebe… / b3b55318… / ae07d4fe… (5c2dc607) | b738c0bb… / 7d517653… / 3ceebe90… | as above |
For a world "on the candidate": the page from an export of the candidate, the land .so (either: identical), and the
candidate-built host binaries above (play2-land-ops config: their full sha256 as the pins). The land4/5 pins remain valid
evidence for land5 only.

## 4. Fresh clone (static, `scripts/fresh-clone-audit.py <repo> 1b115625`)
8,717 tracked files; 6,696 literal references checked (relative/dynamic imports, `new URL(…, import.meta.url)`, screens'
in-page `/…` imports, HTML src/href, Cargo `path =`, `include_str!/include_bytes!`) against the commit's own tree. 76
flagged, all explained, **none a missing tracked file**: installed `node_modules` (screens: playwright-core 1.58.2,
axe-core 4.13.0; gateway: its package-lock), run-time `artifacts/` outputs, the repo root `.`, in-page imports of
other server roots (`/web/…`, `/fixture/…`, council's `/frontier/` = web root), comments and scanner test strings, an
optional local model file whose test skips when absent, and `lang.mjs?load=` queries. Not in git by design: Rust
toolchains 1.89 / 1.95 and platform-tools v1.52 (offline caches), cargo registry caches, Chromium, the play2 ops config.

## 5. Still unverified (each needs a real TEST-ONLY world, the owner's go)
a send that lands; the far-land chip and the yield-per-hour figure in a world; the credited land yield against the
stores; the block-reason, S1 ore, English and return-card fixes in a world; fraying to its end and a retake back;
the candidate-built host binaries in any world; a natural-speed world; phone width (PC first).
