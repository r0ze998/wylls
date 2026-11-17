//! The integration crate has cfg(test); the ordinary library it links does
//! not. Check that opting into public proofs does not give that library a
//! native adapter or open its gameplay gates. No cryptographic call or
//! private-key guard self-test is used as configuration evidence.

#![cfg(all(feature = "public-proof-tests", not(target_os = "solana")))]

#[test]
fn linked_library_keeps_the_proof_adapter_and_gameplay_gates_closed() {
    assert!(!cfg!(any(
        feature = "native-crypto-tests",
        feature = "test-beacon",
        feature = "oracle"
    )));
    assert!(!permutation_frontier::crypto::sys::PUBLIC_PROOF_TEST_ADAPTER_SELECTED);
    #[cfg(feature = "wide-world-experimental")]
    {
        assert!(!permutation_frontier::proc::wide::DEPART_DEBIT_ENABLED);
        assert!(!permutation_frontier::proc::wide::CONQUEST_LIFECYCLE_ENABLED);
    }
    assert_eq!(
        permutation_frontier::QUICKNET_PK_HASH,
        frontier_abi::presets::QUICKNET_PK_HASH
    );
}
