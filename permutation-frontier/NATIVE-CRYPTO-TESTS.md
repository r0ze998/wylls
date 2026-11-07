# Native crypto unit tests

Opt in with `cargo test --offline -p permutation-frontier --lib --features wide-world-experimental,native-crypto-tests crypto::`.
Run ordinary host checks separately with `cargo test --offline -p permutation-frontier --lib --features wide-world-experimental crypto::`.

The adapter is compiled only under `cfg(all(test, feature = "native-crypto-tests", not(target_os = "solana")))`.
It calls the real `solana-bls12-381-syscall` 0.1.1 native math implementation (BE, V0), including point/subgroup validation, multi-pairing and scalar multiplication. It never substitutes a verdict. Its dependency is host-only and dev-only. Enabling the feature on a normal host library does not enable the adapter; SBF always retains its existing syscall imports. No production cryptographic path changes.

The public `valid_q3` and `valid_q4_min` fixture IBE blocks and matching public signatures are reused from `permutation-rules/vectors/seal-vectors-v1.json`. The wide host, destination, world, bell, encrypted body, wide-domain commitment and root are newly constructed; no legacy commitment is used except as a rejection test. Fixture keys are public test material, not generated credentials. No keypair generation, signing, network or deployment is involved.

Coverage: actual key recovery and FO check; valid wide verdicts; malformed U/signature; tampered V/W; mismatched round signature; body/legacy commitment rejection; host, bell and destination-world validation; changed roots. The public quicknet signature at round 32551361 and its hints from the gateway fixture also verify, while another public signature, wrong round and malformed hints fail.

Boundary: native unit tests only. These do not validate SBF execution, runtime syscall availability, compute budgets, LiteSVM, integration-linked libraries, dispatcher/account transitions, or deployed behavior. A test in the same library unit-test build can use this adapter; an integration test links the ordinary fail-closed library. Never treat this as deployment readiness.
