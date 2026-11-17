# Local play: the ordinary-march contract (specification)

The interface between the relay, the page's march module and the UI for the ordinary march (Depart) in local play.
Specification only: the current values live in the code it names.

## Rules
- **`LOCAL_ACT_NAMES` stays the six economy commands:** Join, PlaceHome, Harvest, Build, Train and Muster. `Depart` is
  never looked for there.
- **The ordinary march has its own routes and its own module** (relay `local-play-march.mjs`, page `flocalplay-march.mjs`).
- **The UI reads one value, `FS.localMarch`** (a getter the controller sets). It shows a march control only when
  `FS.localMarch?.open === true`.
- **No conquest gate is involved:** `heapConfirmed` and `pageBinding` are separate and unaffected.

## Routes (relay `local-play-march.mjs`; launcher `WORLD_POST_ROUTES`)
**Closed by default on the server.** The relay builds the march only when all three of these are given; with less,
it refuses to build it and the three routes answer 404:
- `--economy page-signed-v1`;
- `--march-trial local-march-trial-v1` (the test-only entry);
- a pinned `--runner-instance`.

| Path | Kind | What it does |
|---|---|---|
| `POST /gw/f/local-play/march/capability` | read-only | Request `{schema: 'frontier-local-play-march-capability-v1'}`. Answer `{schema, wallet, instance, commands: ['Depart'], reveal: 'keeper', trial}`, only when the runner itself states the pinned instance. |
| `POST /gw/f/local-play/march/submit` | one send | One page-signed Depart, rebuilt exactly and sent at most once. |
| `POST /gw/f/local-play/march/status` | read-only | A read of a signature this relay sent. |

There is no Reveal route: the world's keeper reveals from the public drand round.

## The test-only trial entry
- **Launcher:** `--march-trial local-march-trial-v1` is accepted with the natural preset only, in exactly that word.
  - It passes the same word to the relay.
  - It puts `march=trial` on the page address.
  - Its start answer says `marchTrial: true`.
- **Page:** `localMarchTrialPage` checks the address against the start answer. A mismatch is `LauncherWorldMismatch`.
  The identity carries `march: {instance, trialEntry}` only when the launcher stated an instance.
- **What it stands in for:** `liveProven` only, and only when both hold:
  - the page's entry (`trialEntry === true`);
  - the relay's instance-verified capability says `trial: true`.
- **What it never replaces:** `pageSend`, `keeperArrival`, or any other condition.

## Page API (`permutation-server/web/frontier/flocalplay-march.mjs`)
```js
// 1. once, after connect (the controller does this; not the UI)
const capability = await readLocalMarchCapability({ origin, wallet, expectedInstance, request });
//   → Object.freeze({wallet, instance, trial, relay}) | null      (relay = the exact origin it was read from)

// 2. whenever the page renders: FS.localMarch (the controller's getter) is exactly
localMarchOpen({ capability, wallet, instance, gate, holding, held, trialEntry });
//   → Object.freeze({ open, reason, capability, ready, trial, held })
```

### Binding
The capability counts only while all of these still hold:
- it is this wallet's (`wallet`);
- it is this instance's (`instance`, the launcher's statement now);
- it is this relay's (`gate.relay` equals the origin the capability was read from).

After any switch it is discarded and never carried over.

### The answer
`reason` is the first of these that holds, in this order (`LOCAL_MARCH_REASONS`):

| `reason` | `open` | Meaning, for the UI's own wording |
|---|---|---|
| `LocalMarchNoCapability` | false | This world or relay does not serve the march, or it is unverified, or the page switched wallet, instance or relay. |
| `LocalMarchNotReady` | false | Served, but the readiness conditions do not hold. |
| `LocalMarchGate` | false | The local-play gate is not ok: wallet, signer, relay or host. |
| `LocalMarchWideHolding` | false | Not a legacy village (ring > 128), or no village. |
| `LocalMarchHeld` | false | A march of this host was sent and its outcome is unknown. Offer only "ask" (`ACTIONS['local-march-ask']({signature})`, one read), never "send again". |
| `open` | true | All conditions hold. `trial: true` means the test-only entry stood in for `liveProven`; the UI says it is a trial. |

### Readiness booleans (`LOCAL_MARCH_READY`, frozen)
| Key | Meaning |
|---|---|
| `pageSend` | The page's local Depart: sealed once, signed by the memory wallet, one POST, a memory-only book, no retry, no nudge, no self-reveal, an unknown outcome held and only asked about. |
| `keeperArrival` | The world's keeper settles the departure (legacy SettleDeparture) and resolves the arrival province's turn: the reveal from the public round, gather, resolve, SettleTransit. |
| `liveProven` | A live trial of the above on a natural world. Without it, only the trial entry can stand in. |

`localMarchReady` is true only for exactly-true booleans: `pageSend` and `keeperArrival`, and `liveProven` or the trial
entry. Each value is a reviewed code change, never a runtime switch.

## The page's local send (`createLocalMarchSender`, controller `sendTheMarch`)
- **Gate:** the controller refuses the local march unless `FS.localMarch?.open === true`.
- **One attempt:** the game's own single-attempt `sendMarch`, never `sendMarchRetrying`.
  - The march is sealed once.
  - The book is memory-only.
  - The game's own Depart is built with the memory wallet as fee payer and actor; the relay rebuilds the same bytes.
  - The submit is one POST, with no nudge, no session and no self-reveal.
- **Outcomes:**
  - Only the relay's own pre-send refusals say "not sent".
  - Anything after the POST keeps the signature and stays `sent` in the book. That holds the host
    (`LocalMarchHeld`); it is only asked about, never resent.
  - The relay's answer must carry the program's binding (`ct_hash`, `seal_root`); another binding is held as unknown.
- **Order record:** a local march with a signature is recorded as sent:
  - unconfirmed: an unconfirmed order with its signature;
  - failed on chain: refused, with `sent: true` and its signature.
- **Settling:** in local play the keeper sends SettleTransit, so the page offers no settle action.

## Tests
- `web-frontier-local-play-march-open.test.mjs`: the contract, the trial, the binding.
- `web-frontier-local-play-march-send.test.mjs`: parity with the relay's bytes, one POST, held / refusals / unknown, the
  controller wiring, the order record, no settle offer in local play.
- `frontier-local-play-march.test.mjs`: the relay, closed by default, the capability, the launcher's trial word.
