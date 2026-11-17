# ③ MCP: the ChatGPT caravan flow — six steps, what exists, and the unknown-result display fix (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, one commit on candidate `d16048aa` (the ③ files are identical there and in
this worktree's checkout). Independent of ⑤ (`26247a0f` and earlier) and of ③ `eaf2b97d`; nothing merged.

**Static change, NOT run, NOT integrated. Not published, no tunnel, no ChatGPT device check, no owner login, no village
moved, no caravan sent.** Nothing was executed (no test old or new, node syntax check, import, scanner, server, world,
browser or runner); the two guard-refused frontier tests were not run in any form. auth was read, not changed.

## The flow (10/29 ③ instruction) against the source

| Step | Tool (`mcp/src/tools.mjs`) | Code | State |
|---|---|---|---|
| 1 see my village | `get_village_status` (scope read) | `server.mjs` status | implemented |
| 2 resources short | `check_resource_shortfall` (goal vault / amounts) | `server.mjs` shortfall | implemented |
| 3 prepare a caravan | `prepare_caravan` (own placeIds; planId valid 5 min; sends nothing) | `server.mjs` prepare | implemented |
| 4 confirm | `send_caravan` has `destructiveHint: true` (implementation fact; whether a client shows a confirmation for it is not verified — corrected 2026-11-17, this row first said "ChatGPT asks"); 07: the chat's yes is not authority — scope + signed limits + ⑤ policy/budget + delegation + program rules | annotations | implemented; ChatGPT's confirmation UI not seen |
| 5 send | `send_caravan` (planId, requestId retry key, scope read + caravan) | `server.mjs` send → agent wallet | implemented; the relay allows SendCaravan for agents in S1 seasons (`permutation-gateway/src/frontier/agent/contract.mjs:37`, `gateway.mjs:115-119`) |
| 6 arrived / failed | `get_operation_status`, `list_operations` (after a reconnect) | `ports.mjs receiptOf`, herald events | implemented; **the unknown case was mis-told** (below) |

Remote access: `http.mjs` / `auth.mjs` implement an HTTP endpoint with OAuth; that the code exists is not a deployment.

## The inconsistency fixed (step 6, consumer display)

- Contract (`08-mcp-contracts.ja.md`, state table): `accepted` is "the relay sent the transaction" **or** "an attempt
  whose result is not known (history says so)"; 07: an unknown send is never "nothing sent", it stays `accepted` and is
  decided later.
- Before: the `get_operation_status` description and the receipt's first note said only "accepted = the relay sent the
  transaction", and `next` for every non-terminal operation was "call operation_status again later (arrival is not
  instant; ETA in caravan.arriveAt)" — also for held (`ResultUnknown`, `Inconsistent`, `Indeterminate`, `Duplicate`,
  `ContextChanged`, `SeqUsedByAnotherSend`) and uncertain operations. A consumer could take an unknown result as a caravan
  on its way.
- After (`ports.mjs receiptOf`, `tools.mjs`): a non-terminal operation that is held or uncertain gets `next`: "the result
  is not known yet (CODE): do not prepare or send this again; it is neither delivered nor failed until operation_status
  says so; call operation_status again later"; the note and the tool description name the unknown case. States, holds,
  retries, scopes, limits and the receipt's fields are unchanged; a known send keeps the arrival guidance; terminal states
  keep theirs.
- Paper check: `play.test.mjs:99,132,149,410` (failed/complete `next`), `port-conformance.mjs:62-64` (hold carried) still
  hold; no test pins the changed strings.

## Regression source (written, NOT run)

`mcp/test/unknown-result-display.test.mjs` D1–D5. Imports `ports.mjs` only (no imports there); reads `tools.mjs` as text.

## Remaining (not done; each needs someone else or a decision)

| Item | Kind |
|---|---|
| Run the ③ tests, the new one included | local, not run (pause) |
| A public HTTPS endpoint (no tunnel opened), OAuth with ChatGPT, the connector in the owner's ChatGPT | external, not done; owner's account and settings |
| ChatGPT's confirmation dialog for `destructiveHint` and how it shows `next`/`hold` | device, not checked |
| `RECOVERY.ActionNotAllowed` still says "until patch 0005 is in the relay…" although 0005 is in the candidate's relay; `play.test.mjs:99` pins `/patch 0005/` | wording decision with that test's owner |
| `get_run_status` lists other senders' acts | authorization decision (reported before) |

## Working tree

This round's commit was built from the candidate tree with git plumbing (a temporary index; `git commit-tree`,
`git update-ref`), without switching branches, so the working tree — including the owner's deleted media (25) — was
not touched by any checkout. The two edited ③ files were then written back to their committed content in this
checkout (the ⑤ branch), file by file.

## Checks NOT run (all open)

The new test and every ③ test; no syntax check, import or guard scan.
