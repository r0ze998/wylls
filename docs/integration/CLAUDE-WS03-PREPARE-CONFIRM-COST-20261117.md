# ③ MCP: prepare_caravan's confirm kept the cost and the refusals out (2026-11-17)

Branch `claude/ws03-chatgpt-flow-20261117`, commit after `2300b4f4`, built with a temporary git index (no branch switch;
the worktree's checkout stays on the ⑤ branch, the owner's 25 deleted media and 19 untracked files untouched).

**Static, NOT run, NOT integrated; no client or device.** Nothing was executed (no test, syntax check, import, scanner,
server, world, browser or runner); the guard-refused frontier tests were not run in any form. No charge, amount,
permission, signature, owner check, send or retry behaviour changed; no new permission is suggested. `receipt-port.mjs`,
④'s conformance table, preflight/http/auth/gateway and C's files were read only or not opened.

## The gap

The server instructions say: show prepare's `confirm` text, send only after the person says yes. Before this change
`confirm` held only the cargo, the road time, no recall and raids. What else prepare knew went elsewhere:

| prepare knew | where it was | in confirm before |
|---|---|---|
| settle fee `settleFeeLamports` (`CARAVAN_FEE`, 50000) and who pays (`paidBy`) | `cost` | no |
| that send_caravan would be refused now (policy without SendCaravan, agent stopped, not delegated) | `warnings` | no |
| the agent wallet's per-action price | not read at all | no (and nothing said it was unknown) |

A client that shows only `confirm`, as instructed, could put a send that will be refused, or whose costs are not
stated, before the person as if it were ready and free.

## Costs, from the code (not measured)

- **Transaction fee, Caravan account rent, settle fee**: paid by the relay's fee payer. The agent path goes through
  the relay's `sponsor()` (`permutation-gateway/src/frontier/agent/gateway.mjs` header); the drain guard allows
  SendCaravan `rent(Caravan) + CARAVAN_FEE` from the fee payer (`shapes.mjs`); the agent wallet's terms say
  `networkFees: {paidBy: 'relay', recordedOnly: true}` (`gateway.mjs terms()`).
- **Settle fee ≠ transaction fee**: `CARAVAN_FEE` is escrowed in the Caravan and paid to whoever settles it (or with
  the rent to `RENT_TO` when the beneficiary would stay below rent exemption) (`permutation-frontier/src/proc/caravan.rs`
  header, 0xB2, 0xB6). `game.mjs` already names it `settleFeeLamports`; unchanged.
- **Agent-wallet price**: `prices.game[SendCaravan] ?? '0'` is held from the agent's USDC budget
  (`gateway.mjs` ~639); the relay's config may set it (`config.mjs` ~89). ③ does not read it — so it is said to be
  **not known here**, never free or 0.

## Change

- New `mcp/src/confirm.mjs` (no imports, pure): `prepareNotice(plan, agent)` → `{confirm, warnings, refusals}` with
  the **same three checks and the same warning texts**; `confirm` = the old sentence + who pays the transaction fee,
  rent and settle fee + "an agent-wallet price … is not known here" + (when any) "As things stand, send_caravan would
  be refused: CODES (see warnings); the server checks again at send." It does not tell the person to change a policy,
  mode or delegation. `AGENT_PRICE_NOT_READ`.
- `server.mjs prepare`: uses it; `cost` gains `agentPrice: AGENT_PRICE_NOT_READ` (additive); every other field,
  the plan record and send are unchanged.
- `tools.mjs prepare_caravan` description: says what `confirm` carries. `SERVER_INSTRUCTIONS` unchanged (500).

Existing pins still hold on paper: `play.test.mjs:78` (`confirm` /cannot be recalled and can be raided/), `:95`
(`warnings` /patch 0005/), `instructions-flow.test.mjs` I5. The ⑥ connector (`06-creation/src/connect/caravan.mjs`)
does not read `confirm`, `cost` or `warnings`.

## Regression source (written, NOT run)

`mcp/test/prepare-confirm.test.mjs` P1–P3. Imports `confirm.mjs` only (no imports); reads `server.mjs`, `tools.mjs` as
text. No network, process, key, write or timer. Paper check: the regexes were matched against the same text built in
Python (no product code run): all expected matches hold, the doesNotMatch cases (free / 0 / "would be refused" on a
sendable plan) do not match.

## Open (not this lane's)

- Whether the agent wallet's per-action price should be read and shown (⑤'s terms route; a ⑤/③ contract decision).
- How a real client shows `confirm`, `cost` and `warnings` (device, not checked).
- Whether a send that will be refused should be prepared at all (behaviour change: not made).

## Checks NOT run

The new test, `play.test.mjs`, `protocol-auth.test.mjs` and every ③ test; no syntax check, import or guard scan.
