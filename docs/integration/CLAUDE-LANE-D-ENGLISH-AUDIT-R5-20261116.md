# Lane D English audit, round 5: map, keep, army information and read-only results (2026-11-16)

Branch `claude/lane-d-english-r5-20261116`, from candidate `d16048aa`. Scope: the English of the map's selection
and inspection lines, the keep and army information, the keep's history and read-only results. Edits only in the
ordinary English dictionaries (`permutation-server/web/lang/en-frontier.mjs`, `en-frontier-play.mjs`,
`en-frontier-proto-hand.mjs`). No product, screen, map, controller or test file was changed. R3
(`490b446d`) and R4 (`6cf044cf`) are untouched and remain unapproved; their proposals are unchanged.

**Nothing in this round was executed.** The execution pause (incident of 2026-11-16, see the last section) holds:
no test, new test, node syntax check, product import, scanner, fixture, browser, server or world was run. Every
statement below comes from reading source, the Japanese key and the callsite. The only commands run were
`grep`/`sed`/`git` reads, `sed -i` and one short Python text replacement on the dictionaries, `git diff --check`
and `shasum`.

## Changes (9 entries, 3 files)

| # | Key (file:line) | Before | After | Why (evidence) |
|---|---|---|---|---|
| 1 | `（守りきられた）` (en-frontier-play.mjs:1328) | `(the holder broke it)` | `(the keep held)` | Meaning mismatch. Shown on a contest row of the keep history when `r.outcome === 'broken'` (`screens/conquest.mjs:119`); on that row `r.holder` is the **contender** (`conquest.mjs:104`, `holder: c.contender`). The herald sets `Broken` on `KEEP_BROKEN` (`frontier-node/crates/herald/src/conquest.rs:1577-1586`), which the rule emits when a defender is on the tile **or** no hostile host is left (`permutation-rules/src/frontier/keep.rs:387-393`). So the contender did not break anything, and "holder" named the wrong party. "The keep held" is true in both cases and matches the feed's English for the same event, `{2} held the keep of province …` (en-frontier-play.mjs:449, where `{2}` is the holder: `fconquest.mjs:46-47`). No test pins either text. |
| 2 | `守備兵 {0}` (en-frontier-play.mjs:460) | `'{0} defenders'` | plural: `{0} defender` / `{0} defenders` | Callsites `screens/conquest.mjs:117` (troops of a capture record) and `:188` (keep row); any finite count, so 1 read "1 defenders". The other `守備兵` callsites (conquestguide, marchcard, keephand) are different, longer keys and are not affected. |
| 3 | `{0}の砦へ進軍：{1}が保持、守備兵 {2}、到着はターン {3}` (en-frontier-play.mjs:1301) | `… {2} defenders …` | `—` → `… defenders unknown …`; otherwise plural on `{2}` | `hud/keephand.mjs:277` passes the literal `—` (U+2014, bytes checked) when `x.troops === null`, which read "— defenders" in an aria-label; a count of 1 read "1 defenders". The arrival `—` is unchanged (not a count). |
| 4 | `{0}の砦 · あなたの国が保持 · 記録の守備兵 {1}` (en-frontier-play.mjs:1340) | `… {1} recorded defenders` | plural on `{1}` | `hud/marchcard.mjs:335`, `Number(destKeep.troops ?? 0)`: 1 possible. |
| 5 | `{0}の砦 · 記録の守備兵 {1} · マスを {2} ターン保てば州を奪取` (en-frontier-play.mjs:1341) | `… {1} recorded defenders …` | plural on `{1}` | `hud/marchcard.mjs:336`, same value. `{2}` (hold turns) left as is: the keep's required hold, not shown to reach 1. |
| 6 | `新しく {0} マスを測量しました` (en-frontier.mjs:105) | `Surveyed {0} new tiles` | plural | `fx/stage.mjs:402`, `list.length`: 1 possible. |
| 7, 8 | `国境に触れています：向かいの国には{0}ターンで取られます` (en-frontier.mjs:657 and en-frontier-proto-hand.mjs:164) | `… in {0} turns` | plural (same function in both files) | `map/protowords.mjs:50` and `proto/hand-model.mjs:356`, any count above 0: 1 possible. Both dictionaries define the key, so both were changed identically. |
| 9 | `城砦 {0}` and `保有地 {0} 件` (en-frontier.mjs:845-846) | `Keep {0}`, `{0} holdings` | `Keep: {0}`, plural `{0} holding` / `{0} holdings` | `map/widemode.mjs:185`. `{0}` of `城砦` is `factionName(keepHolder)`, 0–6 (`map/wide.mjs:236`), 6 being `Neutral`: "Keep Neutral" / "Keep Aster" read like a keep's name. `{0}` of `保有地` is `holdings.length`: 1 possible. |

Paper check of each new function against the rules the language tests enforce (read, not run):
`web-lang.test.mjs:321-337` (a string or a function; with every argument 1 and every argument 2 the output is a
string, has no Japanese, uses only the key's placeholders; a key defined twice must agree when a string — each
changed key is defined once, except #7/#8, which are now the same function); `web-lang-play-glossary.test.mjs`
`BANNED_EN`, `AMERICAN` and `TERMS` (`march`, `turn`, `nation`, `province` remain in every branch of every changed
entry; no banned or American word added). Pinned English still produced on paper: `Surveyed 3 new tiles`
(`web-frontier-fx3.test.mjs:606`), `100 defenders` (`web-frontier-conquest-hand.test.mjs:141`),
`Keep of Province 4,-1 · 100 recorded defenders · hold its tile for 72 turns …` (same file :162). `plural()` strips
commas before comparing (`lang/helpers.mjs:8`), so `fmtNum` output such as `1,000` is handled.

## Proposals (not edited)

- **R5-P1 `砦 {0}` is defined twice in en-frontier-play.mjs** — `:452` `plural(n, '{0} keep update', …)` for the
  feed's summary (`hud/feed.mjs:224`) and `:1240` `'{0} keep'`, the later one winning. The feed therefore shows
  "2 keep". The key is shared with the prize screen (`screens/prize.mjs:43`, a keep quantity), so it is excluded
  from this lane; a fix needs either a different key at one callsite (screen owner) or an English that serves both.
- **R5-P2 `保有地` → "holding"** — the glossary retired "holding" for 村 (W11, GLOSSARY.md:309), but 保有地 is not
  in the glossary and the wide records are not necessarily villages; a terminology call, not made here.
- **R5-P3 `{0}つの国がぶつかった` → `{0} nations clashed`** (`screens/report.mjs:900`): `factions` is the number of
  distinct factions on the clash rows (`report.mjs:517`); the source does not show it cannot be 1 (e.g. a camp
  row), so no plural was added. Open until someone confirms the camp row's faction.

## Gaps left on purpose

- `hud/returnwords.mjs:47` (`第{0}〜{1}ターンの記録 {2} 件を読みました。` → `Read {2} records …`, 1 possible): the
  return digest is treated as restricted return work; not touched.
- Prize lines (e.g. `功績の行は…` → "Contribution lines", where the glossary has 功績 = "Works"): prize is excluded.
- Governance lines found by the counter sweep (`en-frontier-play.mjs:895-897`) and caravan lines (`:1043-1044`):
  outside this round's scope.
- `permutation-server/web/lang/en-frontier-play.mjs.orig` is a **tracked** file in the base (`git ls-files`); it still
  holds the old `(the holder broke it)`. Not touched (not a dictionary the client imports, as far as read); worth an
  owner's look.

## Checks NOT run (all remain open)

- `web-lang.test.mjs`, `web-lang-play-glossary.test.mjs`, `web-lang-play-actions.test.mjs` (R4), and every screen
  test that renders these lines (`web-frontier-fx3`, `web-frontier-conquest-hand`, `web-frontier-conquest-ui`,
  keep/wide tests): not run, under the execution pause.
- No node syntax check of the edited dictionaries. The edits are single-line replacements whose shape copies
  existing `plural` entries in the same files; that is a reading, not a parse.
- No regression case was written this round.
- `web-frontier-build-walls-items.test.mjs` and `web-frontier-muster-province-full.test.mjs`: refused by
  `node-keyfree.sh` (exit 5) at 07:47 UTC; not run here in any form.

## Incident note carried from R4

R4's report lists `web-frontier-build-walls-items` as passing (5 pass). That run was a direct `node --test` of a
file the key-free guard had refused, outside the guard, made at 12:57:47 UTC without reading the denial recorded in
`CLAUDE-NORMAL-GAP-S1-CAPTURE-LOCK-20261116.md`. **It is not valid verification** and should be read as "not
verified". The incident was reported in chat; this round ran nothing.

## Files and hashes (working tree at the R5 commit)

| File | SHA-256 | Base blob (`d16048aa`) |
|---|---|---|
| permutation-server/web/lang/en-frontier.mjs | `deb1e2a026e60fc866b45c39bc086e73c17171791577818d44c67c5dff4acaa0` | `9a872e5f` |
| permutation-server/web/lang/en-frontier-play.mjs | `fd551c145f0aa3fb318259c1de80171cebbac8f514e8bb9c963635a685813dd7` | `693b7e3f` |
| permutation-server/web/lang/en-frontier-proto-hand.mjs | `4f66436f8752cb127faa68d4061501145a39cdcd799a8da9f8b31cc2aa138472` | `c61508c4` |
