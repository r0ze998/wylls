# Lane D English, round 6: the march result is "collected", not "resolved" (R3-P1 + R4-P1), 2026-11-16

Branch `claude/lane-d-english-r6-collect-20261116`, from candidate `claude/canonical-candidate-20261116` at
`d16048aa` (local and origin equal when branched). Independent of R3 (`490b446d`), R4 (`6cf044cf`) and R5
(`04b0eb43`); nothing merged or cherry-picked from them. This closes the ordinary WS07 wording gap on
march → collect → march again; it does not close any workstream.

**Implementation saved, NOT runtime verified.** Nothing was executed: no test, node syntax check, product import,
scanner, fixture, browser, server or world. The only commands were `grep`/`sed`/`git` reads, one Python text
replacement (exact-string, each target asserted to occur once), `git diff --check` and `git` save/push.

## The meaning (source read)

- Both Japanese keys say the host waits until the march's **result is collected** (結果を受け取る). The glossary maps
  結果を受け取る to "collect the result" (`permutation-server/web/lang/GLOSSARY.md:349`: SettleTransit / SettleExplore;
  精算 / "settle" is not said on the play screen). "Resolved" is the glossary's word for 決着, a different step.
- The lock: `frontier/fmarch.mjs:92` `hostInTransit` — the host is in a transit record in state 1–3 (I-44: no
  Depart, Dissolve or Explore until the transit is collected). Error `HostInTransit` (program code 58) has the text
  of `frontier/fi18n.mjs:153`.
- "Normally automatic": in local play the keeper sends SettleTransit (`frontier/controller.mjs:1034`); otherwise the
  page offers a collect button only once the arrival round has closed (`settleReady`, `controller.mjs:1035`;
  `controller.mjs:2201` `settleTransit`). So collection is usually automatic but a manual path exists; the English
  keeps the Japanese's "normally" and uses the passive ("is collected"), which does not say who collects it.
- The client already uses this wording for the same lock: `en-frontier-hand.mjs:226` "It cannot be ordered until its
  march's result is collected", and the success line `en-frontier-hand.mjs:246` "March result collected".

## Callsites

| Key | Where shown |
|---|---|
| `この軍勢は、進軍の結果を受け取るまで動かせません` | `frontier/fi18n.mjs:153` `ERROR_TEXT.HostInTransit` → `errorText(58)` / `failureText({code:'HostInTransit'})` (a refused Depart / Dissolve / Explore) |
| `進軍の結果を受け取るまで、この軍勢は出発・解散・探索ができません（ふつうは自動で受け取ります）。` | `frontier/screens/host.mjs:41` `lockedText()`, used at `host.mjs:104` (hosts drawer, locked host) and `screens/tracker.mjs:110` (march card's lock note) |

Neither key is defined in any other dictionary (the tracked `en-frontier-play.mjs.orig` still holds the old English;
not touched, not imported).

## Dictionary changes (2)

| File:line | Before | After |
|---|---|---|
| `permutation-server/web/lang/en-frontier.mjs:502` | `This host cannot move until its march is resolved.` | `This host cannot move until the result of its march is collected.` |
| `permutation-server/web/lang/en-frontier-play.mjs:867` | `Until this march is resolved, the host cannot march, dissolve or explore (it is normally resolved automatically).` | `Until the result of this march is collected, the host cannot march, dissolve or explore (it is normally collected automatically).` |

The requirement (cannot move / cannot march, dissolve or explore until then) is unchanged. "the result of its
march" is used instead of "its march's result" so the rendered march card (HTML, tags stripped by the test) carries
no apostrophe that an escaper could turn into an entity.

## Expectation changes (3 lines, wording only)

| File:line | Before | After |
|---|---|---|
| `permutation-gateway/test/web-frontier-errors.test.mjs:87` | `/until its march is resolved/i` | `/until the result of its march is collected/i` |
| `permutation-gateway/test/web-frontier-relay.test.mjs:365` | `/until its march is resolved/` | `/until the result of its march is collected/` |
| `permutation-gateway/test/web-frontier-march.test.mjs:695` | `/Until this march is resolved, the host cannot march, dissolve or explore/` | `/Until the result of this march is collected, the host cannot march, dissolve or explore/` |

No other line of these files was changed: no fixture, signing, import, logic, runner or other assertion. Neighbouring
assertions read on paper: `errors.test.mjs:88` `doesNotMatch(/settle/i)` still holds; `relay.test.mjs:363`
`failureText(r) === errorText(58)` is unaffected (one source). The language tests' dictionary rules
(`web-lang.test.mjs:321-337`; glossary `BANNED_EN` / `AMERICAN` / `TERMS`, where 結果を受け取 → `/\bcollect/`) are met on
paper. A search of `permutation-gateway/test` found no other pin of the old English.

## Left as is

- `docs/integration/CLAUDE-LANE-B-BLOCK-REASONS-20261116.md:77` quotes the old HostInTransit English; lane B's
  document, not edited.
- R3/R4/R5 proposals other than R3-P1 / R4-P1 are unchanged.

## Checks NOT run (all open)

- `web-frontier-errors.test.mjs`, `web-frontier-relay.test.mjs`, `web-frontier-march.test.mjs` (the three edited
  files), `web-lang.test.mjs`, `web-lang-play-glossary.test.mjs`, and any screen test rendering the hosts drawer or
  march card: not run (execution pause). The relay test also touches signing fixtures; it was read and edited as
  text only.
- No node syntax check of any edited file.
- `web-frontier-build-walls-items.test.mjs`, `web-frontier-muster-province-full.test.mjs`: refused by
  `node-keyfree.sh` (exit 5, 07:47 UTC); not run in any form.
