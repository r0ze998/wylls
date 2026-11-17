# Lane A: first-session keyless screen test (Claude, 2026-11-16)

Branch `claude/lane-a-first-session-20261116`, cut from `claude/continuous-territory-integ-20261115` at 7fc09e28
(which contains round 49, 68e8548d). One new file: `permutation-gateway/screens/first-session.screen.mjs`
(sha256 `82efe93b24e5966f59e1e85da0b9a45172c40a116137d521664c3e7d1625419f`, commit 75e379d2). No page, shared file
or other test was edited. Fixture only: no chain, no key, no world, no localnet, no fixed port.

## How it was run
- Scratch export (`git archive HEAD permutation-gateway permutation-server/web frontier-abi | tar -x`) with symlinks:
  `permutation-gateway/node_modules` → `wylls-normal-home-error-20261115` (lockfile identical to this branch);
  `screens/node_modules` → `wylls-nft-candidate-world-20261115/permutation-gateway/screens/node_modules`
  (playwright-core 1.58.2, axe-core 4.13.0, as package.json pins). Chromium 1208 from the existing cache. No downloads.
  (`frontier-abi` is needed: make-fixtures.mjs reads `frontier-abi/vectors/presets.json`.)
- Base check, each file alone, same export: `local-march-maptap.screen.mjs` 5/5 pass; `conquest-press.screen.mjs` 10/10 pass.
- New file alone: **2/2 pass** (EN, JA at 1440×900), twice in a row (28.8 s the second time).
- It imports the helper `screens/ws07/nokey-page.mjs` (as local-march-maptap does) for the keyless page; no ws07 test was run.

## What each step proves (EN | JA, as shown in the run)
| step | the test does | asserts (shown on the page) |
|---|---|---|
| 1 open | viewer stage `none`, keyless test wallet | 6 nations; start button "Choose a nation to begin" \| 国を選んで始める, disabled |
| 2 nation | person-like press on nation 2 | button becomes "Join Cinder" \| シンダーで始める (`home-confirm`), enabled. **Not pressed.** |
| 3 first village | **fixture**: stage → `holding`, page opened again at the village | the page holds the viewer's village (2,0,7); no nation choice; press on the village → bar says "Train" \| 訓練 and "Form a host" \| 編成 |
| 4 Train | press Train | card `train` with 7 units; confirm "Train 100 Spearmen" \| 槍兵 100 を訓練する on screen, not refused. **Not pressed.** |
| 5 Form a host | press Form a host | card `muster`; confirm "Form 300 Spearmen here" \| 槍兵 300 をここに集める (`data-act=muster`) on screen. **Not pressed.** Closed with ✕. |
| 6 March | press the host chip, then March, then a passable tile 2+ hexes away (in sight, canvas topmost) | bar says "March" \| 進軍; the March card says "Press the destination tile"; order card "March: 600 Spearmen" with "Seal and depart" \| 封をして出発する enabled (the page's planner found the way) |
| 7 Send this order | **test-only in the page**: local play with its march trial open (FS.localPlay.march.trialEntry, worldEndsAt, FS.localMarch open) | the same card's button becomes "Send this order" \| 確認した命令で出発, on screen. **Not pressed.** |
| all | every non-GET/HEAD the page makes is recorded | none to another host; every one to the fixture's `/gw/` and answered by it — **0 were made**; no key operation, no signature asked, no seed stored (NK.assertKeyless); no page error |

Screenshots and the per-language record (`en.json`, `ja.json`) go to `$FIRST_SESSION_OUT` (default: the system temp dir); not committed.

## What it does not prove
- That Join, Train, Form or Send *work*: no sending button is pressed; nothing is signed or landed. Those are the
  live-world evidence of CLAUDE-FIRST-PLAYABLE-STATUS (live23–live34), not this test.
- The first village is not placed by the page here: the fixture's viewer record changes and the page is opened again.
  So the nation chosen in step 2 (Cinder) is not the village's nation in step 3 (the fixture's viewer is Aster) —
  a fixture limit, not a page fault.
- Step 7's local play is written into the page by the test (as local-march-maptap does); it shows the card's word
  for that state, not that the launcher's world reaches it.
- That a host forms or a march arrives, recovers, or takes a keep; turns do not advance (clock fixed).
- Phone widths (PC first, per the status doc), accessibility (no axe pass), a natural-speed world.
- Presses are scripted at measured points: a fixture check, not evidence of an unaided press.

## Page findings
None. Every step showed the expected English (British spelling, none of the banned on-screen words in the strings
checked) and Japanese, with no page error. One observation, not a fault: in local play the order card's header still
reads "Sealed order" above "Send this order" — consistent with the sealed march, so no patch is proposed.
