# Checkpoint handover: ordinary map / UI lane (Claude, 2026-11-15)

No secrets in this file: test keys were memory-only and are gone; no credentials, tokens or key paths are recorded here.

## 1. Where the work stands
- Canonical tree (absolute): `/Users/r0ze/Projects/wylls-codex-wide-inventory-20261109`
- Branch: `codex/wide-conquest-lifecycle-20261109`; remote `origin` = github.com/r0ze998/wylls
- HEAD at this checkpoint: `7cf55a04f4dc34b99ad9f6cdc705a65a2bafea40` (round 43); `git ls-remote origin
  refs/heads/codex/wide-conquest-lifecycle-20261109` returned the same SHA (checked 2026-11-15). The handover note's
  first version is e2245e0b (on top of round 35, 67bf34df); updated f71c249b (after 36), 3c2992df (after 37), fbeb72c2 (after 38), 08de6ea7 (after 39), 6cbd12d4 (after 40), 85eb5090 (after 41) and after 701a7608 (42).
- My recent commits (oldest → newest): 427c4963 (33b ready-again estimate), 35d22713 (33c: charge at settle on b+1),
  8e385098 (34: English for hand.mjs return texts, '{0} can no longer be used', expedition-map clock tests),
  67bf34df (35: with the March card open, a map tap the host cannot act on says why and keeps the host in hand),
  e2245e0b (this note), 3a85aa9c (36: one English per Japanese key — see §7), 31fde707 (37: a tap's refusal that
  repeats the selected host's own reason is drawn once, on the host's tag, which shakes), 2c75bfb4 (38: that holds
  only when the host's reason tag is in sight — on a phone the March card covers it, and 31fde707 showed the reason
  nowhere on the map there; fixed with a hit test), 37a3019a (39: a sentence for 49 page codes and the relay's 2
  request codes; 鐘 → ターン in the wide details line; 精算 → 結果を受け取る in the siege reservation card), 2721acd3
  (40: no "settle" in the action bar's English; a test for it), 7e41786c (41: the "no cooperation board" answer is read
  to its end — it was reported as an aborted request and failed 72 of 78 PC/phone screen scenes), 701a7608 (42: the
  expedition lane's 23 codes have sentences, 精算/keeper/"by itself" off the play screen, the film's frame closes the
  stylesheet again; owner note docs/integration/CLAUDE-EXPEDITION-WORDING-ROUND42-20261115.md), 7cf55a04 (43: the
  Hosts tab says the host is away on a march instead of "No hosts yet, train some" — seen in live33).
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

## 5. The known unit failures: 4 since round 42 (2071 pass / 4 fail / 1 skipped, 2076 tests)
Command (work copy, permutation-gateway): `node --test test/web-lang.test.mjs test/frontier-local-play-*.test.mjs
test/web-frontier-*.test.mjs`. Environment: the gateway's declared SDK (@magicblock-labs/ephemeral-rollups-sdk 0.17.2)
linked into the scratch work copy from an existing install with the same package-lock (nothing downloaded; canonical has
no node_modules); docs/integration/CLAUDE-CONQUEST-RESERVATION-VECTORS-20261112.json copied from canonical.
- Owner's design call (expedition lane, Codex): web-lang completeness (b) (18 Japanese literals held as data in
  fexpedition-return.mjs, shown through t(variable)) and (c) (their 17 English entries, unused to the scanner). Options in
  docs/integration/CLAUDE-EXPEDITION-WORDING-ROUND42-20261115.md; not changed.
- Restricted, not touched: resident-home (NFT viewer records); the outbound "boundary control" test (boundary-control
  safety verification is not to be resumed).
- Flaky under the full run's load (pass alone, 3/3 on base and change): marches "round 29: a turn record that cannot be
  read …" (a bounded wait).
- Fixed: round 36 web-lang "dictionaries"; round 39 relay codes have a text, no numbered bell, 鐘/"bell"; round 42 every
  page code has a text, the film's frame, the internal words.
- Done in round 40: no "settle" in en-frontier-hand.mjs's English (own test); its 3 entries for fexpedition-return's
  精算 strings are left to that lane (their Japanese changes first).
- Screens (browser, keyless fixture, work copy): conquest-press 10/10 and local-march-maptap 3/3 pass; fixtures 7 and
  interaction 9 failures are the same on base and rounds 36–37. Two interaction tests flake only in the long full run
  ("the phone sheet", "the real turn @ 390", "a mouse drag that ends off the handle"): alone they pass on base and
  change. frontier.screen.mjs now runs (work copy: axe-core 4.13.0 and playwright-core 1.58.2 linked from existing
  installs, nothing downloaded): 74/78 since round 41; left: the spectator's "All" button 38 px tall at 360/390 (phone,
  deferred) and two scenes that time out in the full run and pass alone; frontier.screen.mjs cannot load here (axe-core is not installed in the shared screens
  node_modules) — not run.

## 5b. Latest-HEAD build: NOT DONE (disk); live33 on OLD binaries: DONE (2026-11-15 12:09–13:02 JST)
- No HEAD build was made and no world was started after live32. Reason: disk. Free 21.65 GiB; a world must start at
  ≥ 21 GiB free (guard: 110 MiB output / free < 21 GiB, unchanged); a HEAD build needs ~3–4 GiB (runner + herald alone
  took 2.38 GiB in scratch target-resident-fix), so build + world needs ~24.5–25 GiB free (short ~3–3.5 GiB).
- Existing Rust targets (this worktree 9.50 GiB, canonical 10.34 GiB) exceed conquest-guard.sh's 4 GiB absolute cap and
  hold pinned evidence binaries: not usable for a build (the guard is never loosened).
- Since live32's export (427c4963) HEAD changed only permutation-server/web (16 files): no Rust, program or gateway
  source. The pinned binaries (runner c12 d6bc822b, herald 348ab53c, …; built 2026-11-14) are NOT a HEAD build: their
  herald sources (fold.rs, lib.rs, main.rs) and Cargo files differ from committed HEAD.
- live33, run with the owner's approval as a SEPARATE ordinary-play check (not a build reproduction): export of
  canonical 2cd30f23 (page/gateway identical to 46be2f16) + those OLD pinned binaries; synthetic x30 clock (about
  20 s per turn; the 72-turn hold not shortened); TTL 60; ports 41940 / 41944–41953 / desk 41961; memory-only keys;
  one operator by hand (32 presses, each after a looked-at screenshot; 2 positional misses disclosed, nothing sent).
  Result, from the herald's own records (host 151736899600384, the same id on both legs): formed turn 7–8 →
  Depart 1 at 23 (46 @ 24) → arrived unopposed at 26 (48 @ 26, ready 27) → recovered to 74 at turn 52 as the card
  said → Depart 2 at 63 (12 @ 64) → arrived on Borealis's keep (Province −2,4) at 70, fought (0 @ 70, ready 72) →
  held it → "Aster took the keep of province −2,4 from Borealis (turn 141) — Your nation gained it" (provinces held
  Aster 5 → 6). Round 33c's stamina rules held in every row.
- Cleanup by pid at 13:02 (desk quit, launcher SIGINT → stopped.json launcher-closing, guard exited); 0 listeners on
  41900–41999; no world process or headless browser; free 21.49 GiB; guard never fired (output ≤ 17 MiB).
- Evidence (scratchpad, sealed SHA256SUMS 1d06c25c): rec/live33 (notes, screenshots, desk log, host-entries.txt,
  guard log, run script). Limits: old binaries; x30 synthetic; no second player defended or retook the keep; no retake.
- Disk (owner-approved, 2026-11-15 13:05): only listed regenerable download/update caches outside WYLLS were deleted
  (3.24 GiB); two approved items were skipped because their apps were running (1.58 GiB). Free 21.48 → 24.40 GiB.
  The list and log stay local (they name the owner's apps).
- HEAD build still NOT started: it fits the build guard alone (free ≥ 20 GiB, target ≤ 4 GiB), but build + a world
  needs ~25 GiB free (a world must start at ≥ 21 GiB after the build). Freeing the two skipped items when their apps are
  idle would give ~26 GiB. Re-checked 13:11: 24.40 GiB < 25 GiB → no build started (Steam's cleanup is another
  owner's; not touched here).
- Two scopes, never mixed: (1) latest-HEAD build reproduction — NOT DONE; (2) live33 — old pinned binaries + HEAD page,
  x30 synthetic clock — DONE (same-host repeat move and a keep capture).
- Open from live33 (not fixed): the "About this test world" box and a feed notice overlapped at 1280×800 with a drawer
  open; a faithful fixture (flocalplay.css linked) shows the notice on top, so the cause is not stacking — likely the
  notice's translucent background letting the box show through. Needs a look with the real notice before any change.

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
5. PC first (owner, 2026-11-15): the phone March-card layout and the spectator "All" button height are deferred.
   Unverified: the NFT session saw unidentified 404s in its worlds 4–5; a 404 on /coop/config is one guess. Candidates for the next ordinary map/UI round:
   (round 40 did the "settle" entries); the stale English entries the play files no longer use, once their
   owner confirms; on a phone the open March card covers most of the board (destinations only in a strip above it):
   a framing/compact-card design question, not yet changed.

## 8. Restricted — never resume
NFT transfer verification or equivalent procedures, session guard, prize. No real funds, no public issuance.
No account switching, no logout, no new world or heavy build without the space/slot checks above, no deletion.
