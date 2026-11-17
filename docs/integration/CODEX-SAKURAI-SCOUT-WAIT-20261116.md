# Sakurai-inspired review: remaining scout copy

Follow-through on the unofficial Sakurai skill review recorded in the playable checkout's `CLAUDE-FIRST-SESSION-UX-20261113.md`; not a review personally given by Masahiro Sakurai.

## Existing work
The current integration tree retains the three November 13 improvements: forming phase/while-waiting guidance, first-host milestone/next goal, and foldable local-world notice. Lane A's November 16 screen test uses fixtures, not a real world.

## Remaining item fixed
The November 13 record explicitly left the scout card in `screens/onboarding.mjs` outside its patch. Its pre-muster copy still promised roughly 11–21 game minutes. This change replaces that one JA/EN sentence with the actual conditions (turn end, seals opened, turn resolution) and says the player can build while waiting. No rule, timer, send path or game state changed. Separate legacy village-request timing is untouched.

Added JA/EN assertions to `web-frontier-first-village-ui.test.mjs` for the conditions, useful waiting activity and absence of the old fixed range.

## Checks and limits
- Syntax checks passed for both source modules and the test; `git diff --check` passed.
- Dynamic tests NOT RUN: the existing keyfree runner has a previously reported stale-review refusal. No retry, direct-test bypass, list refresh or guard change.
- No world, keys, signatures, transactions, audio or game network calls executed.
- Real formation timing/first-host banner behavior remains unverified under a real world.
- The already-forming scout card's estimated deadline is unchanged; unifying it with shared phase-aware guidance is separate follow-up.
