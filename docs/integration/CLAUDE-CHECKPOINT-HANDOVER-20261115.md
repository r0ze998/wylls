# Checkpoint handover: ordinary map / UI lane (Claude, 2026-11-15)

No secrets in this file: test keys were memory-only and are gone; no credentials, tokens or key paths are recorded here.

## 1. Where the work stands
- Canonical tree (absolute): `/Users/r0ze/Projects/wylls-codex-wide-inventory-20261109`
- Branch: `codex/wide-conquest-lifecycle-20261109`; remote `origin` = github.com/r0ze998/wylls
- HEAD at this checkpoint: `67bf34df0436b081224816a5ee79536760156c50` (round 35); `git ls-remote origin
  refs/heads/codex/wide-conquest-lifecycle-20261109` returned the same SHA (checked 2026-11-15).
- My recent commits (oldest → newest): 427c4963 (33b ready-again estimate), 35d22713 (33c: charge at settle on b+1),
  8e385098 (34: English for hand.mjs return texts, '{0} can no longer be used', expedition-map clock tests),
  67bf34df (35: with the March card open, a map tap the host cannot act on says why and keeps the host in hand).
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

## 5. The 18 known unit failures (same set before and after rounds 34–35; 2013 pass / 18 fail / 1 skipped)
- Work-copy only (files/deps absent from the scratch copy; pass or not applicable in a full checkout): conquest-orders,
  chainio, delegation, fplay-profile, prize, session. (prize/session are restricted areas: not to be worked on.)
- Environment (missing @magicblock-labs/ephemeral-rollups-sdk): agent, errors, relay.
- Other lanes' work (not mine): outbound-arrival-pick (untracked test, Codex lane); pretake-frame ("film's frame");
  resident-home (NFT viewer records — restricted session-guard area, do not resume); words ×2 (numbered bell; 精算 /
  internal words); web-lang ×4: dictionaries (same Japanese → different English), completeness (b) (18 unmarked
  Japanese strings in fexpedition-return), completeness (c) (17 stale English entries), 鐘/"bell".
- The dictionaries conflict (軍勢, 確かめています…, 記録のスロット) is the next item in this lane (see §7).

## 6. Fixture versus a real world: what was seen where
- Seen in a real world (TEST-ONLY, synthetic clock, one operator playing both sides by hand, memory-only keys):
  live29 (natural preset: Join, PlaceHome, train, form, march on a keep, contest recorded), live30–31, live32 (export of
  427c4963: the same host moved, arrived, became ready and moved again — host ID matched on both legs).
- Fixture / unit only, NOT yet seen in a world: 33c (estimate charged at settle on b+1), round 34 English texts,
  round 35 map-tap reason. Whether live30's silent press was exactly the round 35 cause is not proven.
- Known cosmetic: while a province is behind, the host's own map tag says the same sentence just above the tap's note.
- Fresh-clone build + natural-preset start has still not been run (live worlds used exports with pinned binaries).

## 7. Next ordinary UI work
1. Dictionary conflicts: 軍勢 list/tab → "Hosts", single host → "Host"; 確かめています… split into context keys
   ("Checking" / "Verifying"); 記録のスロット → the English that matches what the data is. (Started after this note.)
2. Remaining web-lang failures in my files only (stale entries; leave fexpedition-return to its owner).
3. When disk and slot allow (≥ 21 GiB, other session's all-clear): a short natural-preset world to see 33c–35 live.

## 8. Restricted — never resume
NFT transfer verification or equivalent procedures, session guard, prize. No real funds, no public issuance.
No account switching, no logout, no new world or heavy build without the space/slot checks above, no deletion.
