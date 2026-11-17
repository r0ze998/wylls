# Original host expedition inspection UI

## Scope

The original Frontier host and village hands now offer **Inspect expedition** on real wide-experimental seasons carrying ABI bit `0x4000`. This is the existing game hand, not a history-only viewer or demo. Ordinary seasons and sample/prototype worlds keep their existing controls.

The card says **Check this host at P,Q**. P and Q are explicit inspection coordinates, not a destination and not a claim that the host currently stands there. Canonical decimal strings are kept exact beyond `2^53` through the `±2^62` coordinate bound, and the target must be beyond ring 128.

- A selected original host is resolved afresh from the current subject and its owned original holding. Its full identity is locked to that selection.
- An original village also allows an explicit issued host sequence, so a host absent from legacy province entries can be inspected. `Holding.HOST_SEQ` is the decoded next u32 sequence to issue; the input must be below it for the current generation. Sequence zero is valid. This does not enumerate or assert the existence of live wide hosts.
- The selected subject's issuer is used even when the rail highlights another owned holding. Inspection does not change the rail.
- Wallet-only proposals are supported. The Citizen is derived from the connected wallet and pinned deployment. The proposed payer is that same wallet, never a relay payer. No session is needed or created. NFT resident selection is refused.

## Read contract

`fexpedition.mjs` sends one bounded POST to the optional gateway's `/f/expedition/preview` route. The request pins program, derived Season address, cluster label, exact program version/ruleset hash, original Citizen, the full 56-byte host reference and entered P/Q. `min_slot` is explicitly `"0"`: the page has no coherent RPC context slot and does not fabricate one.

`fexpedition-identity.mjs` is shared with the gateway. It recomputes the 50-byte standing ProvinceKey, original Holding/home, wide Province/roster, four owned bridge addresses, wallet Citizen and ordered resident draft role requirements from public data. Actual immutable Rust Return and Dissolve JSON fixtures independently pin those addresses, role flags and the request digest.

Only a report matching the complete request and digest is displayed. A successful preview requires one coherent response, a context slot meeting `min_slot`, matching Clock slot, exact canonical accounts, closed planner facts and a draft whose action and every role match the canonical contract. All admission, signing, enqueue, dispatch, history verification and completion fields remain false. Proposed signer flags mean signatures would be required, not that authorization was obtained.

Server observations are not authenticated authority, currentness, complete world discovery or completion evidence. In particular, `ResidentMissingHistoryRequired` is a blocker, never proof of return. Reports do not modify selection, map provinces, holdings, composer, marches or marchbook.

## Lifecycle and limits

State lives only in `FS.expeditionPreview`. Every request has a generation, AbortController and immutable identity capture. Late successes and errors are discarded after input changes, repeats, closure/reopening, viewer/session/source/deployment changes, source ownership/generation changes, or selection/rail changes. Failed/missing viewer reads clear the report. Successful semantically unchanged viewer polling preserves pending and completed reports.

The inspection pop disables host movement arming, the generic map action model, far-province and keep tap shortcuts, search-based march shortcuts, and keep-reach lights. It uses text inputs and a dedicated read-only button, not an order form, `ACTIONS`, `handOrder`, relay-info or transaction submission.

Responses are bounded to 64 KiB and have a 30-second client deadline. Error, oversize and timeout paths cancel the reader/request. Output is escaped with the existing HTML renderer. The new labels are localized in Japanese/English.

## Verification

Static import/call-path inspection preceded execution. Exact focused runs used the existing `scripts/ci/no-keys-guard.mjs`; no key generation, private-key derivation, signing, real RPC/network calls, browser boot, Cargo or CI was performed by this UI work.

```sh
cd permutation-gateway
node --import ../scripts/ci/no-keys-guard.mjs --test \
  test/web-frontier-expedition-inspection.test.mjs \
  test/web-frontier-hand.test.mjs \
  test/web-frontier-conquest-hand.test.mjs \
  test/web-frontier-wide-holding-ui.test.mjs
```

The final exact run passed **65/65 tests**, including **18 inspection tests**. The inspection suite covers strict request/response binding, Rust golden parity, invalid pins/ownership/inputs, zero and unissued sequences, multiple owned holdings, close/reopen and out-of-order races, unchanged successful viewer polling, failure/owner/gen invalidation, bounded mocked transport, timeout/cancellation, escaped rendered markup, and preservation of ordinary controls.

The polling regression calls the real controller's `applyMeResult` with decoded public fixture accounts and verifies both pending and completed inspection state. Hand models and markup rendering are called directly. Map shortcuts and DOM event binding are checked in source; those checks do not simulate pointer events or browser layout/focus.

These are Node state/markup and mocked-transport checks, not DOM/browser or visual acceptance. Public dispatch, sealed outbound expeditions, automatic wide-host discovery, live operator configuration and end-to-end deployed execution remain outside this slice. `EXPEDITION_ENABLED` remains false.
