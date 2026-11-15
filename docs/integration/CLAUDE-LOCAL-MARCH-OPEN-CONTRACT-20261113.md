# Local play: the `marchOpen` contract (for the UI owner)

2026-11-13, revised the same afternoon after two independent reviews. Playable copy (P) only; not in canonical. No world, key or signature was used.

## Rules
- **`LOCAL_ACT_NAMES` stays the six economy commands:** Join, PlaceHome, Harvest, Build, Train and Muster. Never look for `Depart` there.
- **The ordinary march has its own routes and its own module.**
- **The UI reads one value, `FS.localMarch` (a getter the controller sets).** It shows a march control only when `FS.localMarch?.open === true`. Today that is never the case: every readiness boolean is `false`.
- **No conquest gate is touched:** heapConfirmed and pageBinding stay false.

## Routes (relay `local-play-march.mjs`; launcher `WORLD_POST_ROUTES`)
**Closed by default on the server too.** The relay builds the march only with all three of these, and refuses to build it with anything less:
- `--economy page-signed-v1`;
- `--march-trial local-march-trial-v1`, the TEST-ONLY entry;
- a pinned `--runner-instance`.

Otherwise the three routes answer 404. The economy flag alone serves no march (`marchFromArgs`, `createLocalPlayMarch`).

| Path | Kind | What it does |
|---|---|---|
| `POST /gw/f/local-play/march/capability` | read-only | Request `{schema: 'frontier-local-play-march-capability-v1'}`. Answer `{schema, wallet, instance, commands: ['Depart'], reveal: 'keeper', trial}`, only when the runner itself states the pinned instance. |
| `POST /gw/f/local-play/march/submit` | one send | One page-signed Depart, rebuilt exactly and sent at most once. |
| `POST /gw/f/local-play/march/status` | read-only | A read of a signature this relay sent. |

There is no Reveal route. The world's keeper reveals from the public drand round.

## The test-only trial entry (so a first live trial is possible without opening production)
- **Launcher:** `--march-trial local-march-trial-v1` is accepted with the natural preset only, in exactly that word.
  - It passes the same word to the relay.
  - It puts `march=trial` on the page address.
  - Its start answer says `marchTrial: true`.
- **Page:** `localMarchTrialPage` checks the address against the start answer. A mismatch is `LauncherWorldMismatch`.
  - The identity carries `march: {instance, trialEntry}` only when the launcher stated an instance. Otherwise the identity is as it always was.
- **Contract:** the trial stands in for `liveProven` only, and only when both hold:
  - the page's entry (`trialEntry === true`);
  - the relay's instance-verified capability says `trial: true`.
- **What it never replaces:** `pageSend` and `keeperArrival`, or any other condition.
- **Starting it:** no live trial has been run. One needs the user's explicit approval first.

## Page API (`permutation-server/web/frontier/flocalplay-march.mjs`)
```js
// 1. once, after connect (the controller does this; not the UI)
const capability = await readLocalMarchCapability({ origin, wallet, expectedInstance, request });
//   → Object.freeze({wallet, instance, trial, relay}) | null      (relay = the exact origin it was read from)

// 2. whenever the page renders: FS.localMarch (the controller's getter) is exactly
localMarchOpen({ capability, wallet, instance, gate, holding, held, trialEntry });
//   → Object.freeze({ open, reason, capability, ready, trial, held })
```

### Binding (independent review)
The capability counts only while all of these still hold:
- it is this wallet's (`wallet`);
- it is this instance's (`instance`, the launcher's statement now);
- it is this relay's (`gate.relay` must equal the origin the capability was read from).

After any switch it is discarded and never carried over. The controller keeps a capability only while the page is still the wallet that asked.

### The answer
`reason` is the first of these that holds, in this order (`LOCAL_MARCH_REASONS`):

| `reason` | `open` | Meaning, for the UI's own wording |
|---|---|---|
| `LocalMarchNoCapability` | false | This world or relay does not serve the march, or it is unverified, or the page switched wallet, instance or relay. |
| `LocalMarchNotReady` | false | Served, but not available yet. **Today's answer on a verified world, a trial world included.** |
| `LocalMarchGate` | false | The local-play gate is not ok: wallet, signer, relay or host. |
| `LocalMarchWideHolding` | false | Not a legacy village (ring > 128), or no village. |
| `LocalMarchHeld` | false | A march of this host was sent and its outcome is unknown. Offer only "ask" (`ACTIONS['local-march-ask']({signature})`, one read), never "send again". |
| `open` | true | All conditions hold. `trial: true` means the test-only entry stood in for `liveProven`; the UI should say it is a trial. |

### Readiness booleans: `LOCAL_MARCH_READY`, frozen, all `false`
| Key | State of the work | Becomes true when |
|---|---|---|
| `pageSend` | **TRUE (2026-11-13)**: implemented, key-free tested, and the independent review of the page path passed with the 23-file canonical set | An independent review of the page path passes. |
| `keeperArrival` | **TRUE (2026-11-13)**: reviewed; the approved real-artifact runs passed (same-home, and another province; order asserted) — `CLAUDE-LEGACY-MARCH-REAL-TEST-PLAN-20261113.md` | It is reviewed, and a real-artifact in-process run passes. That run needs approval: it uses test keys and public drand reads. |
| `liveProven` | **false** — the march opens only on the test-only trial entry | One approved live trial on a natural world passes. Until then only the trial entry can stand in for it. |

Each flip is a reviewed code change, never a runtime switch.

## The page's local send (implemented; `createLocalMarchSender`, controller `sendTheMarch`)
- **Gate:** the controller refuses the local march unless `FS.localMarch?.open === true`.
- **One attempt:** it runs the game's own single-attempt `sendMarch`, never `sendMarchRetrying`.
  - The march is sealed once.
  - The book is memory-only, never localStorage.
  - The game's own Depart is built with the memory wallet as fee payer and actor; the relay rebuilds the same bytes, and a test checks they match.
  - The submit is one POST.
  - There is no nudge, no session and no self-reveal.
- **Outcomes:**
  - Only the relay's own pre-send refusals say "not sent".
  - Anything after the POST keeps the signature and stays `sent` in the book. That holds the host (`LocalMarchHeld`); it is only asked about, never resent.
  - The relay's answer must carry the program's binding (`ct_hash`, `seal_root`). Another binding is held as unknown.
- **Order record (independent review):** a local march with a signature is recorded as SENT, never "not sent":
  - not confirmed: an unconfirmed order with its signature, and the "sent, not confirmed; not sent again" notice;
  - failed on chain: refused, with `sent: true` and its signature.

## Controller hunks (base `db8d000c…`, the UX round; nothing of it reverted)
- imports: `sendMarch` and `flocalplay-march.mjs`;
- the march state and the `localMarchView` getter, set right after `useHerald(h)`;
- the capability read after the memory wallet connects;
- the `sendTheMarch` refusal and its local single-attempt branch;
- the order record for a signed local march;
- the `local-march-ask` action.

Four existing tests that pinned "two unconditional local-play refusals" were updated exactly, not loosened: they now pin one unconditional refusal plus the one march refusal. Also updated exactly: the hooks test's `sendTheMarch` pin and the runner-instance test's two pins (the trial word).

## Tests (no-key guard)
- `web-frontier-local-play-march-open.test.mjs`: the contract, the trial, the binding.
- `web-frontier-local-play-march-send.test.mjs`: parity with the relay's bytes; one POST; held, refusals and unknown; the controller wiring; the order record.
- `frontier-local-play-march.test.mjs`: the relay, default closed, the capability, the launcher's trial word.
- **Whole web and local-play suite:** compared with a baseline mirror built from canonical's copies of the same files, there are no new failures beyond the files the no-key guard stops.
