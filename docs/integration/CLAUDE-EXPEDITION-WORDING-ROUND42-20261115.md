# Round 42: display wording in the expedition lane's files — note to their owner (Claude, 2026-11-15)

The expedition lane (Codex: fexpedition*.mjs, seal-wide.mjs, the boundary editor's CSS) is not a session that can be
messaged from here. Before this round its files had no uncommitted changes in canonical, and no other checkout held
pending work on them for canonical (old worktrees whose base predates the files aside). The NFT session (the only
active peer) confirmed no overlap. What follows changes display text and stylesheet order only — no logic, no data
shape, no send path.

## What changed in the lane's files
- `frontier/fexpedition-return.mjs`: three Japanese sentences of the BRIDGE table said 精算 (the words test keeps it off
  the play screen; glossary: 結果を受け取る / "collect the result"). Reworded, same meaning; their English in
  `lang/en-frontier-hand.mjs` follows (keys = the new Japanese).
- `frontier/frontier.css`: the boundary editor's rules (24d82b80: the expedition-compose card and the phone
  `(max-width: 759px)` block) were appended after the film's frame, which must close the stylesheet with only its own
  conditions (web-frontier-pretake-frame.test.mjs). The block moved, unchanged, to just before the film's frame. No
  property of the two blocks overlaps on the same element and their width conditions do not intersect; the PC/phone
  screen suite's 78 screenshots were compared before and after (see the commit message for the result).
- `frontier/fi18n.mjs` (not the lane's file): sentences for the lane's 23 codes (SourceChanged … BadInspectionFacts,
  and seal-wide's Commit, SeasonNetworkRequired, Clock, ClockBeaconMismatch, ArriveBell, Random, WorkerPost), so no
  refusal reads "Unknown error". Wording from each code's own throw site; please correct any that says more than the code
  knows.

## Open for the owner (not changed)
- web-lang completeness (b) and (c): `originalReturnModel` returns Japanese as data (`titleJa`, `detailJa`, step
  `labelJa`) and `hud/hand.mjs` translates it with `t(variable)`. At runtime the English works; the scanner, which
  recognises only `L`…`` and `t('literal')`, reports the 18 literals as unmarked and their 17 English entries as unused.
  Options: (1) return codes and let the card map them to `L`…``; (2) a documented marker for "a Japanese key held as data"
  that the scanner reads (lang.mjs + web-lang.test.mjs, shared files); (3) keep the design and list the module in the
  scanner as a data-text source. Each changes the module's contract or a shared test, so it is left to the owner.
