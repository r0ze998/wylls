# G1c: a slower `latest` answer tied on seq/slot/bell no longer rolls the land back (2026-11-16, Claude; static, NOT run)

Branch `claude/g1c-land-order-20261116`, cut from integration d8dad205. Source read: Lane C's report
`git show 015e94c8:docs/integration/CLAUDE-LANE-C-G1C-LAND-ORDER-20261116.md` (evidence, checked against the source here,
not taken on trust). Nothing was run, syntax-checked or imported; `git diff --check` and reading only.

## Checked against the source
- `controller.mjs latestEnvelope` skips a field missing on either side (`continue`); `herald.mjs parseEnvelope` gives
  `seq: String(env.seq ?? '')`, so a missing seq is `''` and is skipped. **The report's diff applied its land rule after
  the loop even when no field had been compared** — a missing value would have passed for a tie. Not adopted as written.
- Identity on each side: the decoded Province carries `p`, `q` and `seasonId` (`fcodec.mjs decode`, checked against the
  herald's pin when pinned); `parseLand` checks the record's key and bytes against the envelope's p, q, and its season
  against the pin. The play page pins the herald from the season record before play starts (`app.mjs herald.pin`).
  One land record per season and province (its seed).
- `nextBell` strictly increasing within a season's record, every page-read field written with it (report, from
  permutation-rules land.rs `fold`): taken as read in the report; not re-derived here beyond the rule's two lines cited.

## Change (`controller.mjs latestEnvelope`, inline — `test/web-frontier-land-freshness` builds the body alone)
Only when ALL hold: seq, slot and bell present on both sides, integers and equal; both Provinces the same p, q and
`seasonId` (present); both sides carry a parsed land record of that province with an integer `nextBell ≥ 0`; the held
`nextBell` higher → `{ ...next, land: previous.land }` (the newer answer's Province, arrival slots, day, inputs kept).
Otherwise unchanged (`next`).

## Left alone, on purpose
- One-sided land (a record against none or `null`): cannot be ordered from the bytes (G1b's server-side fold position).
- A season closed and created again: another `seasonId` → no protection (as before). A record closed and created again
  within one season: no program path found (report; not verified here) — if it existed, the guard would hold the old
  land only while the Province itself does not move (any seq/slot/bell difference returns the newer answer).
- Herald unpinned (no play page path found): the land record's own season is then not checked by `parseLand`; the guard
  still needs equal Province `seasonId` on both sides.

## Regression (SOURCE ONLY, not run)
`permutation-gateway/test/web-frontier-land-tie-order.test.mjs`: the function built from text; a real tie with the held
land newer (kept, the rest the answer's), equal / newer (answer), missing or unreadable seq/slot/bell (no tie), another
season / no seasonId / another province (answer), another province's record / invalid nextBell (answer), one-sided land
(answer), non-ties (as before). Existing tests read for impact: `web-frontier-controller` (non-ties, unchanged) and
`web-frontier-land-freshness` (distinct seqs; builds the body alone — kept self-contained).

## Review addendum: the values, fail-closed (2026-11-16, static; NOT run)
Contracts read in the source:
- `herald.mjs parseEnvelope` returns `seq: String(env.seq ?? '')` and `slot` / `bell` exactly as the answer carried
  them (unchecked for `latest`; `bell` checked equal only for a per-bell read).
- The Province is `fcodec.mjs decode('Province', …, { seasonId })`: `p`, `q` from the bytes, `seasonId` a BigInt (u64),
  compared with the herald's pin when pinned; `parseEnvelope` then checks `province.p/q` against the key.
- `land.mjs parseLand` returns the envelope key's `p`, `q` (integers, checked against the bytes' i16) and `nextBell` by
  `getUint32` (0…2³²−1); it checks the record's season only when `seasonId` is passed, i.e. when the herald is pinned
  (the play page pins it from the season record before play: `app.mjs herald.pin`).
Changes (inline in `latestEnvelope`):
- `big()` accepts only a non-negative BigInt, a non-negative safe integer, or a plain decimal string (`/^\d+$/`):
  `BigInt(false)`, spaces, signs, fractions, exponents, unsafe numbers are no value, so never a tie — even the same bad
  value on both sides.
- The province: integer `p` and `q`, and `typeof seasonId === 'bigint'` on both sides, equal.
- `nextBell`: an integer in 0…2³²−1.
Unchanged on purpose: the ordering loop above it (non-ties) keeps its earlier, permissive `BigInt()` — not this item.
Regression: four more source-only cases in `web-frontier-land-tie-order.test.mjs` (rejected values, accepted values,
province identity, the uint32 bound) — not run.
