# Checkpoint handover: ordinary map / UI lane (Claude, 2026-11-15)

No secrets in this file: test keys were memory-only and are gone; no credentials, tokens or key paths are recorded here.

## 1. Where the work stands
- Canonical tree (absolute): `/Users/r0ze/Projects/wylls-codex-wide-inventory-20261109`
- Branch: `codex/wide-conquest-lifecycle-20261109`; remote `origin` = github.com/r0ze998/wylls
- HEAD at this checkpoint: `37a3019ac68f021ff68b4d40fc0469d11d67243e` (round 39); `git ls-remote origin
  refs/heads/codex/wide-conquest-lifecycle-20261109` returned the same SHA (checked 2026-11-15). The handover note's
  first version is e2245e0b (on top of round 35, 67bf34df); updated f71c249b (after 36), 3c2992df (after 37), fbeb72c2 (after 38) and after 37a3019a (39).
- My recent commits (oldest → newest): 427c4963 (33b ready-again estimate), 35d22713 (33c: charge at settle on b+1),
  8e385098 (34: English for hand.mjs return texts, '{0} can no longer be used', expedition-map clock tests),
  67bf34df (35: with the March card open, a map tap the host cannot act on says why and keeps the host in hand),
  e2245e0b (this note), 3a85aa9c (36: one English per Japanese key — see §7), 31fde707 (37: a tap's refusal that
  repeats the selected host's own reason is drawn once, on the host's tag, which shakes), 2c75bfb4 (38: that holds
  only when the host's reason tag is in sight — on a phone the March card covers it, and 31fde707 showed the reason
  nowhere on the map there; fixed with a hit test), 37a3019a (39: a sentence for 49 page codes and the relay's 2
  request codes; 鐘 → ターン in the wide details line; 精算 → 結果を受け取る in the siege reservation card).
- Work copy (scratch, not a repo): `<scratchpad>/canon-copy-round18` — tests are run there against the canonical
  node_modules-free copy; patches are made HEAD-based and applied to canonical with `git apply --cached` + working tree.

## 2. Uncommitted and untracked files in canonical — NOT mine, do not touch
At this checkpoint `git status --short` lists 75 entries, all belonging to other lanes (Codex expedition/reverse lane,
the NFT session, conquest evidence). Modified: docs/integration/CODEX-REVERSE-PRODUCER-20261110.md, fclient/findex/
herald/keeper Rust files and tests, runtime-contract-tests support, screens/codex-route-preview.screen.mjs,
web/frontier/seal-worker.mjs, workstreams/15-coop-outcomes/results/long-run.json. Untracked: many docs/integration
evidence files, Rust tests/fixtures, gateway tests (e.g. web-frontier-outbound-arrival-pick.test.mjs),
`en-frontier-play.mjs.orig`, `scripts/build-frontier-localnet-expedition-sbf.sh`, `screens/node_modules`.
Rule: commit only my own hunks; save `git diff` before, compare after (must be identical); never `git add -A`;
fast-forward push only after remote == HEAD; then check SHA match. Before writing a shared contract file, send the
NFT session paths + hashes and wait for OK.

## 3. Processes, worlds, ports
- Running now: no world, no launcher, no herald/keeper/localnet, no recording desk, no ffmpeg (ps checked).
  No listener on 41xxx (lsof checked).
- Port bands: mine 41940 / 41944–41953 / desk 41961; NFT session 41920 / 41980–41989 / 41996; ⑰ 41100–41199.
  Never two worlds at once; start only after the other session's all-clear.
- Disk: about 22 GiB free. World start only at ≥ 21 GiB free; world guard stops at 110 MiB output or free < 21 GiB;
  conquest-guard.sh unchanged (sha 94baeb7d). No relaxed variant, ever.

## 4. Safe cleanup (if anything is found running later)
- Stop by PID only (never pkill by name). Desk: send `{"op":"quit"}` on its port (closes contexts and the browser;
  memory-only keys go with them). Launcher: its own close path (stopped.json "launcher-closing"), then check ports free.
- Do not delete anything: scratch trees, exports, recordings and evidence (rec/live23…live32, SHA256SUMS) are evidence.
  Deletion needs the user's explicit approval. Videos never go to GitHub.

## 5. The known unit failures: 8 since round 39 (2059 pass / 9 fail / 1 skipped, one of the 9 a flake)
Command (work copy, permutation-gateway): `node --test test/web-lang.test.mjs test/frontier-local-play-*.test.mjs
test/web-frontier-*.test.mjs` (2069 tests). Environment since round 39: the gateway's declared SDK
(@magicblock-labs/ephemeral-rollups-sdk 0.17.2) is linked into the scratch work copy from an existing install with the
same package-lock (nothing downloaded; canonical has no node_modules). With it, agent/errors/relay/chainio/delegation/
fplay-profile load; without it they fail at import (the older 17/18 counts were measured without it).
- Work-copy only: frontier-local-play-conquest-orders.test.mjs (file-level: a module absent from the scratch copy).
- Other lanes' work (not mine): the page-codes test (23 codes left, all the expedition lane's: fexpedition*,
  seal-wide.mjs); words "internal words" (only fexpedition-return.mjs's 精算 now); outbound "boundary control" (Codex
  lane); pretake-frame ("film's frame"); resident-home (NFT viewer records — restricted area, do not resume); web-lang
  completeness (b) (fexpedition-return's unmarked Japanese) and (c) (17 stale English entries for those texts).
- Flaky under the full run's load (pass alone, 3/3 on base and change): marches "round 29: a turn record that cannot be
  read …" (a bounded wait).
- Fixed: round 36 web-lang "dictionaries"; round 39 relay codes have a text, no numbered bell, 鐘/"bell".
- Not done, noted: en-frontier-hand.mjs still has "settle"/"settled" in 3 English entries (exploration/harvest lines);
  the words test checks only en-frontier/en-frontier-play.
- Screens (browser, keyless fixture, work copy): conquest-press 10/10 and local-march-maptap 3/3 pass; fixtures 7 and
  interaction 9 failures are the same on base and rounds 36–37. Two interaction tests flake only in the long full run
  ("the phone sheet", "the real turn @ 390", "a mouse drag that ends off the handle"): alone they pass on base and
  change; frontier.screen.mjs cannot load here (axe-core is not installed in the shared screens
  node_modules) — not run.

## 6. Fixture versus a real world: what was seen where
- Seen in a real world (TEST-ONLY, synthetic clock, one operator playing both sides by hand, memory-only keys):
  live29 (natural preset: Join, PlaceHome, train, form, march on a keep, contest recorded), live30–31, live32 (export of
  427c4963: the same host moved, arrived, became ready and moved again — host ID matched on both legs).
- Fixture / unit only, NOT yet seen in a world: 33c (estimate charged at settle on b+1), round 34 English texts,
  round 35 map-tap reason, round 36 dictionary split (EN/JA screenshots of the Hosts tab and panel on the fixture at
  1440 and 390; the report's Verifying button, the This host fallback and the observation slot line are unit-rendered
  only), rounds 37–38 single sentence in sight (canvas fillText + hit test on the fixture, EN/JA at 1440 and 390x844,
  NotResident only; other block reasons and other phone heights not checked). Whether live30's silent press was exactly the round 35 cause is not proven.
- Known cosmetic: while a province is behind, the host's own map tag says the same sentence just above the tap's note.
- Fresh-clone build + natural-preset start has still not been run (live worlds used exports with pinned binaries).

## 7. Next ordinary UI work
1. DONE (3a85aa9c): 軍勢 / "Hosts" (tabs, lists), この軍勢 / "This host", 軍勢: {0} / "Host: {0}"; 確かめています… /
   "Checking…" vs 照合しています… / "Verifying…"; 記録のスロット / "Record slot" vs 観測のスロット / "Snapshot slot".
2. DONE (31fde707 + 2c75bfb4): the double sentence on the map (the host tag and the tap note), in sight on a phone. The host bar's own note still
   says the same reason a third time, below the map — by design (the bar is the host's card), not changed.
3. Remaining web-lang failures in my files only (leave fexpedition-return and its stale entries to their owner).
4. When disk and slot allow (≥ 21 GiB, other session's all-clear): a short natural-preset world to see 33c–38 live.
5. PC first (owner, 2026-11-15): the phone March-card layout is deferred. Candidates for the next ordinary map/UI round:
   the 3 "settle" English entries in en-frontier-hand.mjs; the stale English entries the play files no longer use, once their
   owner confirms; on a phone the open March card covers most of the board (destinations only in a strip above it):
   a framing/compact-card design question, not yet changed.

## 8. Restricted — never resume
NFT transfer verification or equivalent procedures, session guard, prize. No real funds, no public issuance.
No account switching, no logout, no new world or heavy build without the space/slot checks above, no deletion.
