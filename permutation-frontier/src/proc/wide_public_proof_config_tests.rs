//! Configuration evidence only: no cryptography, signing, key APIs, accounts
//! or instruction execution. This module is a test-only child of `wide`.

#[test]
fn public_proof_adapter_keeps_all_gameplay_gates_closed() {
    assert!(cfg!(all(
        test,
        feature = "public-proof-tests",
        not(target_os = "solana")
    )));
    assert!(!cfg!(any(
        feature = "native-crypto-tests",
        feature = "test-beacon",
        feature = "oracle"
    )));
    assert!(crate::crypto::sys::PUBLIC_PROOF_TEST_ADAPTER_SELECTED);
    assert!(!super::DEPART_DEBIT_ENABLED);
    assert!(!super::expedition_exec::EXPEDITION_ENABLED);
    assert!(!super::CONQUEST_LIFECYCLE_ENABLED);
    assert_eq!(
        crate::QUICKNET_PK_HASH,
        frontier_abi::presets::QUICKNET_PK_HASH
    );
}
