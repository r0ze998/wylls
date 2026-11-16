# ③ MCP: "result unknown" decided by state — a lost answer is unknown, a landed caravan is not (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, seventh commit on `df5f9bcd` (that tip is left as is), built with a
temporary git index (no branch switch; the worktree's checkout stays on the ⑤ branch, its deleted media untouched).

**Static, NOT run, NOT integrated, not published; no ChatGPT device check.** Nothing was executed; the two
guard-refused frontier tests were not run in any form. preflight/http/auth/gateway and C's custody not edited.

## Source facts (df5f9bcd `server.mjs`)

- Lost answer (`resume`, `r.transport`, ~328-335): the operation **stays `requested`**, `unknownSince` is set, `error`
  `RelayUnreachable` ("retry with the same requestId"), no hold, no `uncertain`.
- `uncertain()` (~268-274) sets `uncertain = true` and `unknownSince`, moving to `accepted`; `applyFate` (~560) and the
  expiry branch (~643) set `uncertain = true` too. **`uncertain` and `unknownSince` are never cleared** — after the chain
  shows the send landed (`processing`) they remain as history.
- `track` follows `requested` operations once `unknownSince` is set (~618).

## The inconsistency (in this branch's own earlier commits)

`ports.mjs resultUnknown` (`f1063294`, shared in `df5f9bcd`) was `!terminal && (hold || uncertain)`:
- a lost answer (`requested`, `unknownSince`, no hold/uncertain) → **false**: operation_status and list_operations
  pointed at an arrival time for a request the relay may not have;
- an uncertain attempt that later landed (`processing`, `uncertain` still true) → **true**: a caravan proven on the road
  was told "the result is not known yet".

## The change (③ `ports.mjs` only)

- `resultUnknown`: not terminal and (a hold; or `accepted` with `uncertain`; or `requested` with `unknownSince`).
  `processing` is unknown only under a hold; the history flags are not read there.
- `receiptOf` for `requested` with a lost answer (no hold): "the result is not known yet (CODE): the relay may or may not
  have the request; neither delivered nor failed; call operation_status again later (it asks without sending) — a retry
  may only reuse the same requestId, never a new plan or a new requestId" (the existing same-requestId contract; no new
  send is suggested). Every other case keeps its text.
- Unchanged: states, transitions, retry rules, holds, authorization, sending, costs.

## Regression source (written, NOT run)

- `mcp/test/unknown-result-display.test.mjs`: + D6 (lost answer), D7 (landed after uncertain; a hold still holds).
- `mcp/test/list-result-unknown.test.mjs`: the case table now has requested + unknownSince → true, requested fresh →
  false, processing + history flags → false, processing + hold → true (the earlier artificial "requested + uncertain"
  case — not produced by the server — was replaced).
Both import `ports.mjs` only.

## Next (reviewed, see the closing message): per-operation status recovery / terminal display.

## Checks NOT run

Both tests and every ③ test; no syntax check, import or guard scan.
