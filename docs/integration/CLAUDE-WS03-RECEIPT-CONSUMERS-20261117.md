# ③ receipt contract: its real consumers, and how unknown, held and cancel reach them (2026-11-17)

**Scope:** a static cross-check of ③'s receipt port (`src/receipt-port.mjs`, patches/0006 adopted on ③'s side) against every place that reads it, and against ④'s own run view. Blobs were read with `git show` only.
- **Read at:** `ea2e378b` (this branch); ②'s tips `8037d496` and `2300b4f4` (Lane D, read only); ④ `workstreams/04-execution` and the ⑥/⑬ readers as committed at the same base.
- **Not done:** no test, `node` import, syntax check, server, HTTP or OAuth request; no checkout. No ② file (`budget-port`, `game`, `ports`, `server`, `tools`) and no Lane C file was edited.
- **The held-mapping fix** (`17f4cca4`, local ref only, its push refused) is referred to by hash only. It is not part of this branch, and nothing here republishes it.

**Verdict:**
- **No reachable missing propagation** was found in a file this lane may edit, so **no code is changed**. Every gap below is either an open owner or ④ decision, or sits in a file of ② or ④.
- **The unfinished connection to the main body** is ④'s real adapter behind the port (`receiptPortFor` refuses any name other than `local` and `ws04-mapped`). It is blocked on ④'s view contract and on the hold mapping, both open (§4).

## 1. Who reads the port

| Reader | What it reads | Owner |
|---|---|---|
| `server.mjs` `answer`, `send` failures, `resume` (`CapabilityUnavailable`, `RunRegistryUnavailable`, `RelayUnreachable`, relay failures) | `receipts.receipt(op)` | ② |
| `server.mjs` `track` (raid `taken`, settle) | `receipts.arrival(op)`, stored as `op.arrival` | ② |
| `server.mjs` `ownerOperations` | `receipts.cancellation(link, ops)` per connection, `receipts.receipt(op)` per operation | ② |
| `server.mjs` `runStatus` | `receipts.receipt(op)` per operation of the run | ② |
| `server.mjs` `listOps` (`list_operations`) | **not the port:** `resultUnknown(op)` and `hold.code` directly | ② |
| `http.mjs` `GET /owner`, `POST /owner/operations` | the page prints `ownerOperations`' answer as raw JSON | ③ (not ②'s list) |
| `bin/wylls-mcp.mjs` | `receiptPortFor(WYLLS_MCP_RECEIPT_PORT ?? 'local')` | ③ |
| `e2e/local-stack.mjs:223-251` | under `ws04-mapped` only: `ws04.state`, `ws04.outcome`, `ws04.fees`; never `held_reason` or a cancel phase | ③ |

**Outside ③:** nothing reads ③'s receipt. ⑥ (`src/connect/caravan.mjs:249, 396`) and ⑬ (`resident/ports/ws04-run.mjs:63-79`) read **④'s** run view (`held_reason`, `cancel_phase`, `in_flight`), not ③'s.

## 2. How unknown, held and cancel travel

**Unknown:**
- **`local` port:** `receiptOf` puts it only in `next`, as text, with the hold code when there is one. In ②'s `8037d496`, a lost answer before the window gets its own text: the same `requestId` only, never a new plan.
- **The receipt has no `resultUnknown` boolean;** only `list_operations` has one. The owner page therefore shows an unknown result through `next`, `hold` and `history`.
- **That is consistent, not missing:** both come from the same `resultUnknown`. Whether the receipt should also carry the boolean is ②'s call (it is `ports.mjs`).

**Held (`ws04-mapped` only):**
- `ws04View.held_reason` and `resultUnknown` agree except in two kinds of case, both recorded as open decisions in `CLAUDE-WS03-HELD-MAPPING-FIX-20261117.md` (on the local ref):
  - **a lost answer before the window** (`requested` + `unknownSince`, no hold): `resultUnknown` is true, `held_reason` is null. This is intended: ④'s held is an overlay that stops automatic work, and ③ has not held yet.
  - **holds other than `Indeterminate` and `CapabilityUnavailable`** (`ContextChanged`, `Inconsistent`, `SeqUsedByAnotherSend`, `Duplicate`, `ResultUnknown`) with no `uncertain`: `held_reason` is null. ④'s reasons for these are not decided, and none is invented here.

**Cancel:**
- **`local` port:** `cancellationOf` lists every non-terminal operation of a revoked connection under `awaitingReconciliation`. That includes `processing`, where the caravan is already on the road, so the wording "may have been sent" understates it. This is wording in `ports.mjs` (②), not a wrong state.
- **`ws04-mapped`:** `ws04CancelPhase` per operation:
  - `processing` → `Ineffective`;
  - `completed` and `failed` → `Completed`;
  - any attempt or signature → `AwaitingSigned`, with `until` only from this request's own signature and lifetime;
  - otherwise `StoppingNew`.
- **`Cancelled` is safe:** `ws04View` says `Cancelled` only for `GrantRevoked` with nothing sent. Every `GrantRevoked` failure is written with `attempts === 0` (`server.mjs:282, 307-309` and `703`); with an attempt, the operation goes to `uncertain`. A revoked operation that may have been sent is therefore never shown as cancelled.

## 3. Candidates checked and set aside (not reachable)

- **`ws04CancelPhase(completed)` lists send and settle effects without checking `caravan.mine`,** while `ws04View` gates the same effects on `mine`. It is not reachable: `server.mjs:471` follows settle and raid records only for a caravan proven this request's, so `completed` always has `mine`. No change.
- **`arrivalOf` for `!mine`:** not reachable either, for the same reason. It is defensive only.

## 4. ③'s mock vocabulary and ④'s current run view

③'s `WS04` constant is pinned to ④ `2e536b6b` (proposal 0.2). ④ as committed here (`model.rs`, `store.rs`, `view.rs`, `executor.rs`) differs in three ways.

| | ③ `ws04View` (mock) | ④ run view |
|---|---|---|
| Held reasons | `WalletRequired`, `Indeterminate`, `PortUnavailable`, `Inconsistent` | adds `GatewayRefused(String)`, `SettlementOverdue`, `WorldClosed`, `DestinationMismatch`; `Inconsistent(String)` |
| `held_reason` form | the bare name | `Option<String>` written as `format!("{why:?}")` (`executor.rs:538`), e.g. `Inconsistent("…")` |
| Cancel | `{ phase, until: { lastValidBlockHeight, unit, signature, source } }`, only in the cancellation | `cancel_phase` in the run view, serde's default externally tagged form: `"StoppingNew"`, `{"AwaitingSigned":{"until":N}}`, `{"Completed":{"effects":[…]}}`, `{"Ineffective":{"at":"…"}}` |
| Other view fields | — | `terminal`, `in_flight`, `cancel_requested`, `sent`, `settled`, `effects`, `view_version` |

**Effect today:** none. No reader of ③'s `ws04` field reads `held_reason` or a cancel phase (§1), and ⑥/⑬ read ④'s own view.

**Effect on the real adapter:** an adapter that passes ④'s view through would change the cancel shape and add held reasons that ③ does not map. Building it needs, first:
1. ④'s view adopted as the contract (version, and whether the Debug-string held form is part of it);
2. the owner's mapping for ③'s other holds (§2);
3. whether `PortUnavailable` stays the stand-in for `CapabilityUnavailable`.

## 5. What is left, and whose it is

- **The ④ adapter:** blocked on decisions 1–3 above (the owner, ④).
- **A `resultUnknown` boolean in the receipt, and the cancellation wording for `processing`:** ②'s `ports.mjs`, offered as notes only.
- **The held-mapping fix `17f4cca4`:** a local ref only. Its push was refused and is not retried.
