# First-session UX: integrated into canonical (UX only)

2026-11-13. This applied the playable copy's first-session UX patch to canonical (C) and ran the keyless regressions. The order was agreed with the other owners: UX goes into C first; the march lane writes only in P for now and integrates its own diff later.

No world, key, signature, send, publish or push was used. Nothing was scheduled.

## What was applied
**Patch:** `CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113.patch`, sha256 `c1e9e7120c6a3140015a584737fe6740c13d2401c76083371a7c96a66f048125`.
- It is the same file as P's `CLAUDE-FIRST-SESSION-UX-20261113.patch` v2.
- The design and the reasons are in P's `docs/integration/CLAUDE-FIRST-SESSION-UX-20261113.md`.
- **The three improvements:**
  1. the muster wait reads the turn pipeline's real phase, plus one thing to do meanwhile;
  2. the first host is said once, with a goal this world can take, and the march answer comes from `FS.localMarch` alone;
  3. the test-world notice sits under the dial and folds on a press, always keeping the key-loss line.
- **v2 wording:** "Forming up: {0}. …" (the review found "100 Spearmen is forming up" unnatural).

**How it was applied:**
- with `patch -p1` (a dry run first on copies);
- 16 files changed and 2 new;
- no file was copied whole from P.

**Base check, just before applying:**
- every round file in C matched P's round base, except `lang/en-frontier-play.mjs` (`2c0581b2…`);
- that file differs from P's base only by C's two lines at 904–905, the "order sent but not confirmed" pair;
- both lines are kept after the patch.

**March changes:** none are in this patch.
- The file list is exactly the round's 18 files.
- From v1 to v2 only the English wording and its test lines changed.
- The new test writes out the contract's reason list instead of importing `flocalplay-march.mjs`, which C does not have yet.

### controller.mjs: three display hunks, none in the send path
1. `resetViewer`: `FS.formingBells = []`.
2. `readMarches`: the read-only `formingBells` loop (herald `bellFacts` of each forming host's muster turn), then `FS.formingBells = forming` after the existing `key !== bookKey()` check.
3. `musterOrder`: only the order line's Japanese text.

C's controller after this patch is `db8d000c2024b4db…`. **The march lane should base its controller hunks on that.**

## Saved before applying (folder `CLAUDE-FIRST-SESSION-UX-C-INTEGRATION-20261113/`)
- `c-before-files.tar`: C's 16 changed files as they were.
- `c-before.sha256`, `c-after.sha256`.
- `git-status-before.txt` (HEAD `8836f1aa`, 280 status lines) and `git-diff-before-round-files.patch` (C's own uncommitted changes to these files vs HEAD). Both were left in place.
- `tests-before-summary.txt`, `tests-after-summary.txt`.

## Files (C before → after, sha256 first 16)
| File | Before | After |
|---|---|---|
| permutation-server/web/frontier/controller.mjs | 91c220d720915d13 | db8d000c2024b4db |
| permutation-server/web/frontier/hud/hand.mjs | 84781fb5fb6d1191 | 7e829fe2a56cbcdb |
| permutation-server/web/frontier/hud/turnlist.mjs | 5830e288a1a878e7 | fbfc79d0d7b79e40 |
| permutation-server/web/frontier/hud/keephand.mjs | 6d8573935750858c | b65413be3ac32ee5 |
| permutation-server/web/frontier/hud/guide.mjs | 9eddca3c3c1b9e7d | 2c639bc04b32de55 |
| permutation-server/web/frontier/hud/milestones.mjs | 62acbef4ea385218 | a35596b6afe063b3 |
| permutation-server/web/frontier/screens/holding.mjs | e117180baa47969f | 4406a2c16fffa226 |
| permutation-server/web/frontier/screens/conquestguide.mjs | eae03ba9b69761a8 | fa583ffed4325750 |
| permutation-server/web/frontier/flocalplay-session.mjs | 4cc8f50df280d085 | 0d6bfcddca99049b |
| permutation-server/web/frontier/flocalplay.css | 20f7465a3607169b | 944f22808dba704f |
| permutation-server/web/lang/en-frontier-play.mjs | 2c0581b2193eceb3 | 04a5758a3e4af543 |
| permutation-server/web/lang/en-frontier-hand.mjs | df6432c72799e20b | 01b29334da098b32 |
| permutation-gateway/test/web-frontier-conquest-hand.test.mjs | 576a4e5985ee842b | 5a6012717b1b1f0e |
| permutation-gateway/test/web-frontier-conquest-ui.test.mjs | 2b5773313b9057a5 | 3921cb87c7e9cc9c |
| permutation-gateway/test/web-frontier-hand.test.mjs | 414b6a750732fc2b | 720bd5b76ae682d2 |
| permutation-gateway/test/web-frontier-proto-hand.test.mjs | 8d02b3fff447d993 | f415d1d2b9a995d4 |
| permutation-server/web/frontier/hud/firststeps.mjs | (new) | 3bd3d3fe2f72aaf5 |
| permutation-gateway/test/web-frontier-firststeps.test.mjs | (new) | 10599dde5c8db60c |

## Regressions in C (no-key guard on every run)
The set was the 65 files that import the changed modules, the text-pinning files and web-lang, plus the new file afterwards. Each file ran alone under `--import ./permutation-gateway/screens/codex/no-key-node.mjs` with a 300 s cap.

| Run | Pass | Fail |
|---|---|---|
| Before the patch | 585 | 72 |
| After the patch | 594 | 72 |

- **The fail difference is none.** Every failing file fails the same test titles before and after:
  - key-making files stopped by the guard;
  - web-lang's five known findings, identical apart from line numbers;
  - unrelated baseline failures.
- **The 9 added passes** are `web-frontier-firststeps.test.mjs` (9/9).
- **Affected tests after the patch:**
  - web-frontier-conquest-hand 14/14, conquest-ui 9/9, hand 12/12, proto-hand 43/43;
  - cards 6/6 (which holds the play screen's banned words);
  - local-play-session 5/5.
- **Two files of the set are absent from C:** `frontier-live-connect-fresh.test.mjs` and `web-frontier-live-connect-a-page.test.mjs`. They were not run, before or after.

## Integrated vs not played
- **Integrated and keyless-tested in C:** the code, wording and tests above.
- **Fixture-viewed (in P, not a live page):** English desktop and phone screens.
- **Not played:**
  - no live world was run with these changes: the real herald answers for a forming host, the real dial and strip, and the banner timing after a real formation;
  - C has no `FS.localMarch` until the march lane integrates, so local play answers "closed".
- **Outside this round's files:** `screens/onboarding.mjs`, where the scout card still says "about 11–21 game minutes".
