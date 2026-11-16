# ④ act receipt: how its state is obtained, what is stored, and what can be told about where it came from (2026-11-17)

**Scope:** a static trace of `runexec act status` from the command line to the receipt, and of what the readers keep. Blobs were read with `git show` only.

**What was read, at `f9376faa` (this branch's base) unless noted:**
- **④:** `src/main.rs` (`act`), `src/acts.rs` (`refresh`, `receipt`, `HttpFateReader`), `clients/acts.mjs`, `bridge/agent-gateway-bridge.mjs`.
- **The wallet:** `permutation-gateway/src/frontier/agent/gateway.mjs` (`actionFate`, `actionFateView`) and `contract.mjs`.
- **③:** `bin/wylls-mcp.mjs`, `server.mjs` `consult` and `runStatus`; the candidate `eaf2b97d` (`claude/ws03-registry-correlation-20261117`).
- **⑤:** `fada02f9` (`claude/ws05-cancel-until-readvia-20261117`, on `d16048aa`) and `6cd7a788` (`claude/ws05-from4-readvia-20261117`, on `fc43eb72`).

**Not done:** no test, import, syntax check, HTTP, RPC, authentication, signing or world; no product edit and no integration. ③ and ⑤ are in Lane D's editing area and were read only.

**Excluded:** the refused commit `17f4cca4` is not on this branch.

## 1. The paths through `runexec act status`

| Path | Chosen by | What answers | Source |
|---|---|---|---|
| **store-only** | no `--gateway` (④'s client built without `gatewayPort`, or `status(q, {read: false})`) | the last stored reading, unchanged | `main.rs` `act` → `acts::receipt` |
| **wallet** | `--gateway <port>` without `--bridge` | one `GET /f/agent/fate?id=&key=` on 127.0.0.1, then recorded | `main.rs` → `acts::refresh` with `HttpFateReader{gateway_path: true}`; `acts.rs` `fate` |
| **test bridge** | `--gateway <port> --bridge` (`createActsClient({bridge: true})`) | `GET /fate?key=` on ④'s test bridge. Its own header calls it a **MOCK** whose chain is the wallet tests' scripted chain, which "finalizes every transaction at once". | `acts.rs` `HttpFateReader{gateway_path: false}`; `bridge/agent-gateway-bridge.mjs:1-18, 90-91` |
| **register / list** | `act register`, `act list` | stored rows only (`list` never reads the wallet) | `main.rs` `act` |

**Behind the wallet path:**
- `actionFate` finds the action in the agent's kept history. With a signature, it asks `fateOf(this.ctx.connection, …)` (or the custody's own reading).
- The answer is `actionFateView`: `retained`, `key`, `status`, `sent`, `signature`, `lastValidBlockHeight`, `slotFloor`, `signedAt`, `state`, `fate`, `commitment`, `queryFailed`, `why`.
- **No field names the cluster, RPC endpoint, or whether the connection is a simulator.**
- The wallet itself can answer `state: "unqueryable"` with HTTP 200, for an action no longer retained or a failed chain query.

## 2. What ④ stores, and what its receipt shows (`acts.rs` `refresh`, `receipt`)

**A read that answered, on a non-final act:**
- `facts` becomes the wallet's whole answer.
- Only `signature`, `lastValidBlockHeight`, `slotFloor` and `signedAt` are carried over from before when the new answer lacks them.
- A previous `lastReadError` disappears with the old facts.

**A read that failed, on a non-final act:**
- The state becomes `unqueryable`, the old facts are kept, and `lastReadError` is set.

**A final act** (`landed`, `failed`, `expired`, `not-sent`):
- It never changes.
- A contradicting reading goes to `conflict`.
- A failed read is not recorded at all.

**What the receipt (`p04-acts/0.1`) shows:**
- `state`, `final`, `signature`, `signedAt`, `lastValidBlockHeight`, `slotFloor`, `commitment`, `why`, `lastReadError`, `conflict`, `cancel`, `next`, `newAttemptAllowed`, `source`, `agentId`, `idempotencyKey`, `registeredSlot`, `runId`, `retention`.

**What the receipt does not show:**
- **which path produced it** (store-only, wallet or bridge);
- **when** the stored reading was taken (no read time is stored);
- **the state before an `unqueryable`**. The previous wallet `fate` stays inside `facts`, but `receipt` does not output it. So an act that was `unknown` (`next: "hold"`, never send again) reads `unqueryable` (`next: "read-again"`) after one failed read. The hold signal is lost from the receipt.
- **any chain, cluster or simulator.**

## 3. What can be told, and from where (decided from adopted text)

| Question | Can it be told? | Grounds |
|---|---|---|
| Was this receipt freshly read from the wallet, or from the store? | **Not from the receipt.** The caller can say it, from how it built ④'s client (`gatewayPort` given, `bridge` not set, `read` not false). | `clients/acts.mjs` `status`; ④'s receipt has no such field. ⑤'s `fada02f9` takes exactly this approach (`readVia`: `gateway`, `store-only`, or null when unknown). |
| Wallet or test bridge? | **The caller only:** ③'s and ⑤'s loaders never pass `bridge`. | `bin/wylls-mcp.mjs:45` (`createActsClient({bin, db, gatewayPort})`); ⑤ `loadFourActsPort` in `fada02f9` ("this loader never asks for ④'s test bridge"). |
| How old is the stored reading? | **No.** ④ stores no read time. A caller's own call time is when it asked, not when ④'s data was observed. | `acts.rs` `save` writes `state` and `facts` only. |
| What was the state before `unqueryable`? | **Not from the receipt.** | `refresh` overwrites `state`, and `receipt` omits `facts.fate`. |
| Chain or simulator? | **No, at any layer of the act path.** A wallet reading is the wallet's answer about whatever its connection is. The bridge is a scripted mock. | `actionFateView`; the bridge header. ⑤ already labels this `chain: null` with `REGISTRY_CHAIN_NOTE` (`fc43eb72` line, kept in `6cd7a788`). |

Turning any of these into chain evidence, or into a trust rule, is **not** decided here.

## 4. Existing candidates compared (to avoid duplicating them)

| Candidate | What it does | Overlap with this trace |
|---|---|---|
| ⑤ `fada02f9` | `fourActsPort` tags each answer `readVia` (`gateway` when the loader had a gateway port, `store-only` for register, list, `read: false` or no port, null when not told); the substitute does the same; `status-query` passes it on; `RunReceipt` stores `cancel.until` | **The caller-side `readVia` rule of §3.** For ⑤ only. |
| ⑤ `6cd7a788` | `actFrom4` keeps `readVia` (only `gateway` or `store-only`, otherwise null) in `from4`, including the mismatch branch | **Reads `r.readVia`**, which only `fada02f9`'s port sets. The two are on separate lines (`d16048aa` and `fc43eb72`). Without `fada02f9`, `6cd7a788` stores null: safe, but it says nothing. **They are to be taken in together.** |
| ③ `eaf2b97d` | `consult` refuses a receipt naming another key; keeps `signature`, `idempotencyKey` and `source`; `at` is the last read that answered; `readErrorAt` added; `ws04CancelPhase` uses `until` only for this request's own signature | **No `readVia`.** "A read that answered" includes a receipt whose own `state` is `unqueryable` (④'s wallet read failed inside `runexec`), and ④'s `lastReadError` is not kept (§5). |
| ⑤ `fc43eb72` | registry key exact; no cross-signature reads; finals kept; registry is not chain evidence | Agrees with §3's chain row. ⑤ maps every non-final registry state to its own open `unknown` (`acts-port.mjs` `txStateFromActs`), so ④'s lost hold does not make ⑤ send. |

## 5. Gaps in an existing reader (change candidates only, not made)

### ③-1. ③ stores a registry answer without saying how it was obtained

**Where:**
- `bin/wylls-mcp.mjs:45` builds ④'s client with or without `WYLLS_MCP_WS04_GATEWAY_PORT`, and never with `bridge`.
- `server.mjs` `consult` and `runStatus` cannot tell which, because `createWyllsMcp` receives only the client.

**The effect:**
- With no gateway port, ③'s `ws04.act.state` and its `at` look like a fresh reading, but they are the store's last one.
- `runStatus`'s `acts.list` rows are always store-only.

**Candidate (same vocabulary as ⑤'s `fada02f9`, no new rule):**
- **`bin`:** pass `actsReadVia: gatewayPort ? 'gateway' : 'store-only'` to `createWyllsMcp`.
- **`consult`:** store `ws04Act.readVia` with it.
- **`runStatus`:** mark `list` rows `store-only`, and `status` rows with the same `readVia`.
- **Owner:** `server.mjs` is Lane D's file, so this comes after `eaf2b97d`.

**Acceptance:**
1. `readVia` is only `gateway`, `store-only` or null, taken from configuration, never from ④'s answer.
2. `gateway` never implies chain evidence, finality or a fresher time.
3. No path reads the wallet more often than today.
4. The default `local` receipt, `applyFate`, sending, grants and `register` are unchanged.
5. Any test is written, not run.

### ③-2. An `unqueryable` receipt counts as a read that answered (on top of `eaf2b97d`)

**Where:** `eaf2b97d` `ws04ActAfterRead` sets `at` and drops `readError` for any receipt that arrived.

**The problem:** ④'s rule says `unqueryable` "says nothing about the act" (`acts.rs` `next_step`; `clients/acts.mjs` header), and ④'s own `lastReadError` is dropped by ③.

**Candidate:**
- When `a.state === 'unqueryable'`, leave `at` as it was;
- keep ④'s `lastReadError` (as `ws04Act.lastReadError`) and `why`;
- record the time as `readErrorAt`.

**Acceptance:**
1. `at` moves only when ④'s receipt state is not `unqueryable`.
2. ④'s `lastReadError` and `why` are kept as text and are never parsed.
3. A final state is never replaced, since ④ already keeps it.
4. Otherwise `eaf2b97d`'s acceptance holds unchanged.

**Owner:** Lane D, with or after `eaf2b97d`.

### ④-1. The receipt loses the state before `unqueryable`

**Where:** `acts.rs` `refresh` (state overwritten) and `receipt` (no previous state or `facts.fate`).

**The effect:**
- `unknown` (hold) turns into `unqueryable` (read again) after one failed read.
- ③ is not affected for decisions: it decides from the wallet's own fate in `applyFate`, and the registry is display only.
- ⑤ maps both to its open `unknown`.
- ⑬'s `toWs13Status` throws on `unqueryable` (R5), so it never shows `unknown` there.

**The candidate is for ④'s owner, not decided here:** `receipt` could add the last answered state (for example from `facts.fate`, or a stored `lastState`).

**Acceptance:**
1. The current `state` and `next` keep their meaning.
2. The added field is the last state an answered read gave, never inferred.
3. `receiptVersion` is raised if the shape changes.

### Not candidates

- **A chain, cluster or simulator field anywhere on the act path.** It would need the wallet to report its connection, and a trust policy. That is new specification.
- **A read time stored by ④:** the same.

## 6. What is decided here, and what is not

**Decided from adopted text:**
- `readVia` is the caller's knowledge of how it built ④'s client.
- The test bridge is never used by ③'s or ⑤'s loaders.
- A receipt's `unqueryable` is not a fresh observation.
- The act path carries no chain evidence.

**Not decided:**
- any upgrade from registry or wallet reading to chain evidence;
- any trust policy;
- ④'s receipt shape (④-1);
- the order of intake for ③ (`eaf2b97d`, then ③-1 and ③-2) and for ⑤ (`fada02f9` with `6cd7a788`). That belongs to Lane D and the parent session.
