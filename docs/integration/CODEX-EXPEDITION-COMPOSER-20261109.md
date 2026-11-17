# Original-host outbound route preparation

## Scope and boundary

The existing original host hand now offers **Prepare a boundary route** on real wide-experimental seasons. This is source-only preparation, not executable route planning or outbound sending. Ordinary marches and the read-only expedition inspection card remain separate.

The source must be the currently selected, observed original resident host. A village sequence, forming/pending/transiting host, duplicate resident observation, unissued sequence, inconsistent issuer/owner or missing viewer is refused. The selected host issuer is used even when another owned holding is active in the rail. The origin is the observed current tile, not the issuer's home.

Six existing hex directions append adjacent geometric steps. Undo/reset are local. The route is bounded to 32 steps and four entered provinces with the codec's Rust-order account keys. Its endpoint comes only from those steps and must lie outside ring 128 before a plaintext proposal appears. A small route sketch uses bounded relative coordinates; wide/global coordinates stay exact decimal strings.

The card offers the existing four stances, retreat presets (including a canonical decimal custom ratio), and three season-derived tip presets. Arrival is a canonical u32 proposal entered by the player. No route-land or coherent clock/travel-cost verification is claimed, including for an arrival that is not actually reachable. The legacy WASM planner is never used to certify a mixed original/wide path.

The review shows all 136 plaintext bytes, full host/province identities and, when derivable, nine canonical public Depart role proposals. The candidate transit slot comes only from a well-shaped four-entry original Holding transit observation. Full or inconsistent slot data yields no role proposal. Current slot availability, ownership authority, departure readiness and arrival legality remain unverified. Proposed signer flags mean required signatures, not authorization obtained.

Every dispatch, executable, admission, sealing, signature, enqueue, automatic-send and completion flag is false. There is no Seal/Send control. No salt/key generation, encryption, signing, transaction, gateway read, session creation, map/province mutation or marchbook write occurs in this module. Public dispatch remains closed.

## Lifecycle

State is isolated in `FS.expeditionCompose`, separate from `FS.compose` and `FS.expeditionPreview`. Each local change produces a new immutable review. Closure/reopening clears the route. Source/selection/wallet/session/viewer/pin/ownership/generation/issuance/host movement or resident/transit changes clear it. Relevant Season timing/tip fields, the chain source and meaningful clock observations are pinned; identical observation copies and receipt-time-only changes preserve it. Unrelated Season counters do not reset it.

The actual controller open/edit/input/reconcile and `applyMeResult` paths are tested. Semantically unchanged successful decoded account polling preserves the draft; failed/missing viewer reads clear it. Map action arming, far-province, keep, keep-light and search march shortcuts are guarded while the card is open. Existing inspection semantics are retained.

## Verification and limits

Static source/import/call-path inspection preceded the exact guarded Node runs. No browser/server startup, live network/RPC, key generation/private derivation/signing, sealing worker, Cargo, CI, commit, push or deployment was performed by this UI task. Test account states are synthetic local UI initial states using the existing reviewed public Season fixture, not fabricated native-runtime outcomes.

```sh
cd permutation-gateway
node --import ../scripts/ci/no-keys-guard.mjs --test \
  test/web-frontier-expedition-compose.test.mjs \
  test/web-frontier-expedition-inspection.test.mjs \
  test/web-frontier-hand.test.mjs \
  test/web-frontier-conquest-hand.test.mjs \
  test/web-frontier-wide-holding-ui.test.mjs
```

The focused run passes 80/80 tests, including 15 composer tests. Codec/role Rust-vector parity is covered in the separately owned codec/role test suites. The hand model and markup renderer are called directly; map shortcuts and DOM bindings are source-bound checks, not simulated pointer events.

An additional whole `web-lang.test.mjs` run passed 22/24 tests, including new-key completeness, with two failures already present in HEAD `9394fe3e`: conflicting English for `記録のスロット` in `en-frontier.mjs`/`en-frontier-play.mjs`, and existing `鐘`/`Bell` wording in `map/widemode.mjs`/`en-frontier.mjs`. Those files are unchanged by this UI slice.

Browser DOM, responsive layout, focus and visual acceptance were not run. This preparation slice is not evidence of end-to-end original-game outbound execution.
