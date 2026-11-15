# Fable handoff: local-play return steps (Dissolve / Return) — source checkpoint, 2026-11-11

Worktree: `/Users/r0ze/Projects/wylls-claude2-overviews-20261110` (branch `claude2/overview-loading-20261110`).
Main (`/Users/r0ze/Projects/wylls-codex-wide-inventory-20261109`) was only read. Nothing committed, pushed, built,
started or copied to main. No Rust build. No binary or service touched.

## What this is

The existing return of an original host that stays in wide land has three steps:

1. `OwnerDissolve` — player-signed (`action: "Dissolve"`)
2. `ResolveVoluntaryLeave` — the turn's own processing; **nothing is signed for it and nothing here sends it**
3. `ReturnOriginalReserve` — player-signed (`action: "Return"`)

Main already had the read (preview `original-host-wide-resident`), the return card, the general gateway's unsigned
review (`POST /f/expedition/prepare`) and the resident CLI (`frontier-experimental-expedition-prepare`). The dedicated
local-play relay had no resident route, and its preview route served only the boundary card's snapshot request, so
in local play the return card could neither read nor send. This change wires steps 1 and 3 for local play only.

No chain rule, next-province march, host list or design was added.

## Contract

Relay (all loopback, behind the herald's `/gw/*`, only when the relay is started with the new optional flags):

| Route | Body | Answer |
|---|---|---|
| `POST /f/local-play/resident/prepare` | the existing `frontier-experimental-expedition-prepare-request-v1`, whole | `{report, submit}`; `submit: null` when the report is blocked |
| `POST /f/local-play/resident/submit` | `{schema: "frontier-local-play-resident-submit-v1", message_digest, transaction_b64}` | `{status: "submitted" \| "unknown", signature, status_route}` |
| `POST /f/local-play/resident/status` | `{schema: "frontier-local-play-resident-status-v1", signature}` | `{signature, status: pending \| processed \| confirmed \| finalized \| failed, err, slot}` |
| `POST /f/expedition/preview` (existing) | now also the original-host inspection request, only with `wallet` AND `payer` equal to the relay's pinned wallet | the adapter's validated report |

- Preparation is the existing adapter `createExpeditionPrepare` unchanged, under the relay's pins: localnet, the
  local-play program, its Season PDA, version `18436`, the S1 ruleset, the relay's runner RPC, the relay's
  `--cu-limit` / `--loaded-limit`, fee payer = the pinned wallet. Scope is refused before any spawn.
- Submit and status are the Depart relay's own machinery (`createLocalPlayRelay({ flow })`): exact prepared message,
  one signature by the pinned wallet, replay barrier until the real block height passes, one send, status only.
  The resident flow has its own barrier; a resident message is unknown to the Depart relay and the reverse.
- The general gateway's `POST /f/expedition/prepare` is not served by the local-play relay and is unchanged.

Browser (`flocalplay-return.mjs`), two presses:

1. **prepare** — rebuilds the request from the card's validated observation (`preparationRequest`), posts it, checks
   the whole report (`preparationReport`) and the submit note. Nothing is signed. The card shows the action, the
   message digest and the last valid block height.
2. **send** — the memory-only wallet signs that very message; the signature is verified in the page; one submit.

Asked again after every wait (prepare answer, connect, signature, same turn as the POST): the departure's gate, the
identity (program, Season, cluster, wallet, the live signer object, program version, ruleset) and the card's
observation (state, report, request, herald source, relay, wallet/session objects, the selection). Any change ends
the run unsent. An unknown outcome is asked about by its first signature only. An observation a step was sent on is
used up until the card reads again. "confirmed" means this step's transaction was confirmed, nothing more.

## Launch change (for whoever starts the relay; not done here)

`local-play-relay-server.mjs` takes one more optional flag, apart from the relay's closed configuration:

```
--resident-bin <absolute path of frontier-experimental-expedition-prepare>
```

Without it the three resident routes are 404, as before. `--preview-bin` is unchanged. An existing binary was seen
(listing only, not run) at
`/Users/r0ze/Projects/wylls-claude2-map-20261110/frontier-node/target/debug/frontier-experimental-expedition-prepare`
(3,850,888 bytes, Nov 11 00:36). Whether that build matches the running program was not checked.

## Files (13). Before = main at the time of this work, after = this worktree (sha256)

Modified (limited patch against main: `docs/integration/fable-local-play-return-20261111.patch`, 25 hunks):

| File | Before | After |
|---|---|---|
| `permutation-gateway/src/frontier/local-play-relay.mjs` | `ac7830df0a4b29658a281f40ee575d623a3e2e705f58b1e6bdd14a92b3459292` | `2e566aac87acd59edfdd166d42101535d316e4e2521ee282d1a4e6e188977e44` |
| `permutation-gateway/src/frontier/local-play-preview.mjs` | `77d18217c4dbf974bb72c29e06804d7f238162fe0031d5b2a5b09ccf1d5bff77` | `519c903afe741ecc2d051658d5ba9c884e66afa6b089872053a5a227c32d3383` |
| `permutation-gateway/src/frontier/local-play-relay-server.mjs` | `8c212420e51d24967f06e425ae0ccf52220c8a2281264405aafd682a66897d1e` | `66c262fd1155514df621f444551b6185be3f8698e9e3c9a41adfa38753e8a669` |
| `permutation-server/web/frontier/controller.mjs` | `84c88728fa11a4b1a9df7eb56527b808aeefb5da2ec950f34363a8501db48e97` | `71609354c36c8afb1d7ba29a6cb9b44fa597bdad73cc316e745f857f7c8aae6b` |
| `permutation-server/web/frontier/hud/hand.mjs` | `a09c3ece865a2036b1f9dddc6ad0b30c22f0320183aff7f1cfa9df16391adaab` | `d3c5934f2f0aabf54b395b73575544c6d1ab9384afe0c5c60540539232e5e0fa` |
| `permutation-server/web/frontier/app.mjs` | `7def80faccc5dd1822d6f0c9ddee890ca8cfb1c85d324a3ad9dabb3e5ae44a53` | `dae63016f42890080e1b9a6c88e78c20c498d3b283fd7f7fb5d9a3cae611178a` |
| `permutation-server/web/lang/en-frontier-hand.mjs` | `a717f5baad94b980cdee36c16e2ef6cb98028774cb09a52c09356a3815180abe` | `78e3a9fe2f5aadea8169ca41a4ab95ebc2ca060ddfe0732a0d9db3b8edd8a55a` |
| `permutation-gateway/test/frontier-local-play-preview.test.mjs` | `eb3271c7a40f015dfd59b60bb319fd7c467f088f6d07bcabbf7a3a796903f2da` | `8ae8bc0e78494af8bfc511b54208e561ec789545369db416daf6e6457fde1ba8` |
| `scripts/ci/node-key-tests.txt` | `2a00e2e4811dd973931dda50254b4a95ea482f6f027ebc8b8e82fc827e8eb493` | `60caaa3e7270f423472e6c6fe3204434e858e78d1a5c4699db53090ae6c7e5b0` |

New (absent in main):

| File | sha256 |
|---|---|
| `permutation-gateway/src/frontier/local-play-resident.mjs` | `ce1a21d0ba5c851cc9f0e582e0b58a02b48a70a0699aeb218cd6f93c136f48af` |
| `permutation-server/web/frontier/flocalplay-return.mjs` | `253b9f431cc2ee630bbfa70b0f91e0c6e8aa9e619e6ee5692110969c6f664492` |
| `permutation-gateway/test/frontier-local-play-resident.test.mjs` | `86be6f7f6df93561e16d351d98857bfde732e3f12a4487be323590cdeeef0035` |
| `permutation-gateway/test/web-frontier-local-play-return.test.mjs` | `70c24188acadf929ee45f7aa2da88260344447981b87a438409c760757d5f45b` |

`app.mjs` change is three additions (import names, three HUD actions, one constant plus one prefixed condition on the
card's click line). `hand.mjs`: one new function, one call, and `!FS.localPlay` on the general unsigned-review
section (its route does not exist on the local-play relay). No CSS file was touched.

If main's `app.mjs`, `hand.mjs` or `controller.mjs` has moved from the "before" hash, apply the patch hunks rather
than copying the file.

## Worktree base

Before starting, seven files of this worktree that were older than main were replaced with main's versions
(`local-play-reveal.mjs`, `controller.mjs`, `fexpedition-reveal.mjs`, `flocalplay-reveal.mjs`, `seal-wide.mjs` and
the two reveal tests), and main's `web-frontier-expedition-prepare.test.mjs` was added. The previous versions and
their hashes were kept outside the repository (session scratchpad, `return-start-snapshot/`); they are not needed
for integration.

## Tests run here (Node only)

| Run | Files | Result |
|---|---|---|
| no guard (key-using) | `frontier-local-play-relay`, `frontier-local-play-reveal`, `frontier-local-play-resident` | 30 / 30 |
| no guard (key-using) | `web-frontier-local-play-return`, `-reveal`, `-depart`, `web-frontier-local-play` | 35 / 35 |
| no-key guard | `frontier-local-play-preview`, `frontier-expedition-prepare`, `web-frontier-expedition-prepare`, `web-frontier-expedition-return`, `web-frontier-hand` | 43 / 43 |

New tests: gateway resident 6, browser return 8, preview +1. Key classification: two lines added to
`scripts/ci/node-key-tests.txt` (`frontier-local-play-resident`, `web-frontier-local-play-return`).

`web-frontier-words` + `web-lang` under the guard: 23 pass / 7 fail, the same seven and the same counts as before
this change (37 texts without English: `flocalplay.mjs` 21, `hud/hand.mjs` 12 in the general preparation block,
`controller.mjs` 3, `wallet.mjs` 1; `map/widemode.mjs`; `fexpedition-return.mjs`). None names a string of this change.

## Not verified

- No real browser, relay process, runner or SBF program was used. Every prepared report in these tests is the
  repository's synthetic one.
- The resident preparation keeps the existing no-heap message (three budget instructions plus the dispatch) and the
  relay's `--cu-limit` / `--loaded-limit`. Depart and Reveal needed a 256 KiB heap frame on the real program; whether
  Dissolve or Return also do is unknown. If they do, that is a change to the Rust CLI and its report contract, not
  to these files.
- The preview binary's inspection mode against a live `original-host-wide-resident` was not run.
- The card's wording and layout were not looked at on screen.
