# Integration review: `codex/territory-opening` against `origin/main` (2026-10-17)

Read-only. Nothing was merged, resolved, stashed or retired. `origin/main` = 2321d557, `codex/territory-opening` = 0e4ff915, merge-base ad1c919d (2026-10-04). The diffs read are in `.local/review/*.diff` (`git diff -U6 codex/territory-opening origin/main -- <file>`; a `-` line is territory-opening's, a `+` line main's).

## 1. The seven files with the largest territory-only residue, by function

| File (territory-only lines) | What the residue is | Main's counterpart | Verdict |
|---|---|---|---|
| `web/frontier/controller.mjs` (65) | the old `refreshMarches(holding)` that loaded the book once, waited on the herald, wrote it back; the viewer refresh inlined (`me` → land stage, `landEnd`, `ticketSeen`, `sessionProblem`, quota); `sendMarch` with `DEPART_MARGIN_SECS`; the home-grant ack inlined; the Explore sentence 「結果は次の鐘のあとに出ます」 | `readMarches` serialized by `refreshMarches()` (one reading at a time, the book re-read after every wait, the "settled too early" guard — comment dated 2026-10-11, after territory-opening's last commit); `applyMeResult(me)` with the same land-end / ticket-seen / session checks (verified by grep: `landEnd`, `ticketSeen`, `matchesCitizen`, `sessionProblem`, `NotFound`, the error text); `sendMarchRetrying` + `departMargin(rate)` (re-sends when the turn rolls over); `ackHomeGrant()`; `exploreResultTurn/Words` | main is the later form of the same functions with fixes; no behaviour only territory-opening has |
| `web/frontier/map/fmap.mjs` (58) | `WATCH_WORDS_MS 4200`, the territory wash drawn only with `territoryEnabled`, `paintKeeps` on plain tiles, the watch painting without clipping, `survey:gain` without `kind/claims`, the camera guard | `WATCH_WORDS_MS 9000`; the conquest `KeepBoard` (keeps on unsurveyed land, captures, the camera to a capture), the banner prototype board, `TOUCH_TILE_ZOOM` for phones, watches washed once and clipped outside banner land, the same `survey:gain` plus two fields, the `moment` camera rule | main extends every function; the residue is the pre-keeps / pre-prototype form |
| `web/frontier/app.mjs` (44) | imports (`sendMarch`, `DEPART_MARGIN_SECS`, `tileHex`/`project` only), drawer rendering without the prototype cards, `FAN.ry 204`, hand pops limited to `hand.POPS`, the muster camera rule | the prize screen under 領土, the prototype hud, keep hand, `FAN.ry 240` (the token cleared the name plate), `CONQUEST_POPS`/`PROTO_POPS`, the "cards over board" camera rule, the drawer title timing fix (recording of 2026-10-11) | main ⊇ territory |
| `web/lang/en-frontier-play.mjs` (35) | 13 Japanese keys that only territory has, all with 鐘 ("bell") as a counted or periodic word (「鐘が鳴りました — ターン {0}」「次の鐘」「ターンと鐘」…); 22 keys whose English changed | main's vocabulary rule (test `web-frontier-words`: the bell only tolls, numbers are a turn's; `battle`→`clash`, `muster`→`form` per the glossary) retired these keys and rewrote the English | superseded wording, not a feature |
| `web/lang/en-frontier.mjs` (34) | 15 keys only on territory, the same 鐘 wording (「村が決まる鐘まで」「次の鐘で」…); 19 keys with new English (pluralised, glossary) | same | superseded wording |
| `permutation-gateway/citizens/verify-minds.mjs` (26) | the M7 listing of signatures inline; the older header text | `listedSignatures()`, plus the seal checks (`sealedLastTurn`, `sealAccounts`: the registrar's signed anchors index, the setup transactions Join/PlaceHome counted) — new checks, same M7 | main ⊇ territory |
| `web/frontier/hud/feed.mjs` (21) | `snapshot(FS, now)` without `prev`; the feed kinds without `keep` and `explore` | `snapshot(FS, now, prev)` (a march once seen resolved stays so; the destination keeps its name after the clash), keep events (`keepItem`, `KEEP_NEWS_BELLS`), the viewer's exploration results from the log | main ⊇ territory |

Conclusion for the seven: every territory-only hunk is an earlier form of code that main changed on purpose afterwards (serialisation of the march book, retries over a turn roll-over, the extracted viewer state, keeps and the prototype board, the vocabulary rule). I found no fix in them that main lacks. The evidence is the hunks themselves (the file-level identifier counts of the first round were the hint; this round read the hunks).

## 2. The 143 uncommitted entries of the territory worktree (`~/.codex/.chatgpt-projects/…/wylls-territory`), read-only

101 modified tracked files (+505/−341 lines) and 42 untracked paths. They are one coherent, **unmerged art and VFX track**, not scattered edits:

| Group | Paths (examples) | In main? | Kind |
|---|---|---|---|
| New art sets | `web/frontier/art/terrain-v2/`, `art/tile-motion-v1/`, `art/world-details-v1/`, `art/vfx/`, `art/units/mobs-v1/`, `art/ui/illustrated/`, `art/leaders3d/motion-v1/sprite*/…_victory.webp` (6 nations) | no (directories absent) | assets |
| New modules | `fx/asset-vfx.mjs`, `fx/asset-vfx-data.mjs`, `fx/battle-vfx.mjs`, `fx/confirmed-vfx.mjs`, `map/tile-motion.mjs`, `map/world-details.mjs`, `map/territory-centres.mjs`, `world-details-preview.{html,mjs,css}` | no | feature code (presentation) |
| Dictionary | `lang/en-frontier-art.mjs` + `lang.mjs` registration (`frontier-art` group) | no | i18n |
| Modified modules | `map/sprites.mjs` (+157/−28; 18 of 154 added lines already in main), `people/minis.mjs`, `hud/icons.mjs`, `fx/battle.mjs`, `map/village.mjs`, `leader-motion-data.mjs`, `people/battle.mjs`, `hud/hud.mjs`, `fx/stage.mjs`, `frontier.css`, `app.mjs`, `screens/holding.mjs`, … | mostly no (0–10 of N added lines found in main's copy) | feature code |
| New tests | `test/web-frontier-{asset-vfx,latest-design,terrain-art,tile-motion,ui-art,world-details}.test.mjs` | no | tests |
| Modified tests | `web-frontier-{setpieces,leader-art,leader-demo,players,leader-sprite,cards,hero,hud,seat,wave4-map}.test.mjs` | no | tests |
| Design and audit docs | `docs/frontier/art/leaders3d/STAGE.md` (+27/−66), `art/units/README.md`, `art/leaders3d/_src/*.py` (render scripts), `latest-design-audit.json`, `latest-mob-audit.json`, `docs/frontier/ux/UX-DESIGN.md` (2 lines) | no | design records |

**Candidates to bring over, if wanted** (as one topic branch cut from the worktree, after its owner confirms the work is finished and its tests pass on main): the art sets and their modules and dictionary (rows 1–3), the modified modules that carry them (row 4), their tests (rows 5–6), the docs (row 7). Nothing of this touches the agent wallet. What I did not assess: whether these changes are complete (an uncommitted working tree may be mid-way), and whether `map/sprites.mjs`'s 157 added lines sit on top of main's version or territory-opening's (they were written against the latter).

## 3. Policy

Unchanged from DESIGN.md §8.2: `main` is the trunk; `feature/agent-wallet` is main plus its own commits (fast-forward); `codex/territory-opening` is already in main in later form and can be retired once its owner agrees; the art/VFX track above is the one thing worth carrying, as its own branch. Decisions wanted: (1) retire territory-opening or keep it; (2) whether and when to cut the art/VFX track into a branch; (3) who owns the uncommitted worktree (I did not touch it).

**The owner's decision (2026-10-17, fourth round):** `main` is the base. `feature/agent-wallet` is **not merged before the real-browser verification** (DESIGN.md §13). `codex/territory-opening` is **not deleted**; its uncommitted art/VFX track (§2) is kept as it is and brought in later as a separate track, after the agent wallet. Nothing in that worktree was changed, stashed or retired in this round either.
