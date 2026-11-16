# Lane D round 4 — build, training, collection and march English (2026-11-16)

Branch `claude/lane-d-english-r4-20261116`, cut from candidate `d16048aa`. Independent of round 3
(`claude/lane-d-english-r3-20261116` at `490b446d`, not approved for integration): none of its fixes are repeated
here, and its open proposals (R3-P1 HostInTransit, "captured record") are left alone.

Scope: the play screen's text for building, training, collecting results and marching — descriptions,
quantities, durations, placeholders and conditions — outside ERROR_TEXT / CLIENT_TEXT (round 3). Only language
dictionaries, one new pure test and this report were changed. Not touched or judged: onboarding / first-session /
conquestguide / hud guide / app cg-go (main), land / herald (Lane C), the expedition return, resident, NFT, prize
and payment lines.

## Method

1. Every `L`…`` / `Lh`…`` template and `t('…')` key in `permutation-server/web/frontier/**/*.mjs` (except `proto/`)
   was extracted with its key made the way `lang.mjs` makes it (`templateKey`), and looked up in `EN`: 4,256 call
   sites. No Japanese key the screens use lacks English (the 303 misses are ids and comment ellipses).
2. Mechanical checks on the in-scope strings (391 build/train/collect/march keys and 220 quantity/cost/duration
   keys): the same placeholders on both sides, the numbers in the Japanese are also in the English, banned words,
   American spelling, curly apostrophes, 結果を受け取る said as "collect", and 決着 never "clash" unless the
   Japanese is about a fight.
3. Every string was read against its Japanese, and every candidate was checked at its call site before changing.

## Fixed (each through the real `L` lookup in `web-lang-play-actions.test.mjs`)

| # | Where (call site) | Japanese | Was | Now | Why |
|---|---|---|---|---|---|
| 4-1 | `screens/s1.mjs` S1_BLOCK NoHostHere | このマスに、着いて落ち着いたあなたの軍勢がいません（…） | has arrived and **settled** on this tile | has arrived and **is standing** on this tile | "settle" is banned on the play screen; the condition (`s1.mjs:181`, entry state 1 on the tile since a resolved turn) is a host standing there |
| 4-1 | `screens/s1.mjs` S1_BLOCK NoFighterHere | この村のマスに、着いて落ち着いた…戦う軍勢… | arrived and **settled** on this village's tile | arrived and **is standing** on… | same |
| 4-2 | `screens/host.mjs` PENDING_TEXT 5 | 解散待ち（決着のあと控えに戻る） | back to the reserve after **the clash** | after **the turn is resolved** | a dissolve waits for the turn, with or without a fight; matches turnlist / hand ("after this turn is resolved") |
| 4-3 | `screens/holding.mjs` promotionRow | 産出 +{0}% · 蔵 {1} · 建設 {2} つ · 村のまわり {3} マス | {2} **under way** · land {3} **out** | {2} **builds at once** · land {3} **tiles around the village** (plurals) | 建設 N つ is how many builds the next tier runs at once (`gives.slots`), not N in progress; 村のまわり is the village's land radius (`gives.radius`) |
| 4-4 | `hud/statusview.mjs` costView 'unsettled' (2) and `screens/s1.mjs:512` | 未確定（額はまだ決まっていません）/ 未確定：最大 {0} / 使える量（未確定の費用を…） | **Unsettled** … | **Undecided** … | "settle" is banned (the ban's `\bsettle` misses "unsettled"); matches the sibling line "not called paid until it is decided" |
| 4-5 | `hud/orderparts.mjs` whyText WallsBusy | 城壁の工事は 2 つ先までです。前の工事が仕上がり、そのターンが決着してからです | …ahead. Once an earlier one is finished and its turn is resolved | …can wait at once. Another can be ordered once an earlier one is finished and its turn is resolved. | the English ended in a fragment and never said what becomes possible; the rule is `rulebook.mjs:196` (both wall places waiting) |

Commits: `1e3b3080` (4-1 to 4-3 and the test), `ac6f5a12` (4-4), `6ef0f5e9` (4-5).

Changed files (sha256, first 16):
- `permutation-server/web/lang/en-frontier-hand.mjs` `069e77f04935a6c9` (4-3, 4-5)
- `permutation-server/web/lang/en-frontier-play.mjs` `90f21eec52c53838` (4-1, 4-4)
- `permutation-server/web/lang/en-frontier.mjs` `569f086cb7843041` (4-2)
- `permutation-gateway/test/web-lang-play-actions.test.mjs` (new) `933c17a434bcc26e`

The new test imports `lang.mjs` and reads the screens' source text only. It also checks that each Japanese key is
still in its screen's source, so a changed call site fails there instead of leaving a dead entry, and it guards the
whole `EN` against "unsettled", "settled" for 落ち着く, and "after the clash" for 決着のあと.

## Tests (each file on its own, node v20.19.4)

| Test | Pass | Fail | Todo |
|---|---|---|---|
| `web-lang-play-actions.test.mjs` (new) | 6 | 0 | 0 |
| `web-frontier-build-walls-items.test.mjs` (pins `/two works on the walls/`; imports rulebook / holding / orderparts, no network or storage) | 5 | 0 | 0 |
| `web-lang-play-glossary.test.mjs` | 18 | 0 | 0 |
| `web-lang.test.mjs` | 24 | 0 | 0 |

A text search found no other test that pins any English changed here. Not run: anything else, including the
full gateway suite.

## Left as proposals (not changed)

- **R4-P1** `screens/host.mjs` lockedText 進軍の結果を受け取るまで…（ふつうは自動で受け取ります） says "Until this
  march is resolved … normally resolved automatically". The Japanese says the result must be **collected**
  (as `hud/orderparts.mjs:102` and `screens/explore.mjs:41` already say). Same family as R3-P1 HostInTransit, and
  pinned by `web-frontier-march.test.mjs:695`, so it is left for the owner to take together with R3-P1.
- **app.mjs:368** "What a march costs (in lamports)": "lamport" is on the ban list, but the Japanese says
  ランポート on the same Details panel, so the English is faithful; showing the unit at all is a product choice.
- **Curly apostrophes** (16 entries: en-frontier-play 9, en-frontier-proto-hand 6, en-frontier 1, e.g. "one host’s
  limit", "your village’s first project"): against the glossary style, cosmetic, not changed.
- `flocalplay.mjs:528` "receiving their results" (結果の受け取り) on the local-play start page: the glossary word is
  "collect"; cosmetic.

## Not checked

Browser rendering (no screenshots, no world or server); the owners' areas listed above; the expedition-return,
resident, NFT, prize and payment lines.
