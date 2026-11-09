//! Verification-only proof of the shared IBE recovery and legacy 165-byte
//! opener against an unchanged, published quicknet fixture. This is NOT a
//! wide 264-byte seal or bridge-lifecycle proof.
//!
//! Cargo's `harness = false` keeps `cfg(test)` fixture readers available
//! without registering or running the imported modules' unrelated tests.
//! This target runs exactly one proof by default. It accepts one name
//! filter, `--exact`, `--list`, and `--test-threads=1`; other arguments fail
//! before the proof. No production module, feature or dispatch gate changes.

#![cfg(not(target_os = "solana"))]

#[cfg(any(
    feature = "native-crypto-tests",
    feature = "test-beacon",
    feature = "oracle"
))]
compile_error!("public_seal_verification requires ordinary production quicknet features");

extern crate alloc;

// Preserve the production source's crate-local references. The linked
// program library retains its normal fail-closed host syscall behavior.
use permutation_frontier::crypto::sys::SysError;
pub use permutation_frontier::{error, heap, markers, Error};

#[path = "../src/crypto/field.rs"]
mod field;
#[path = "../src/crypto/quick.rs"]
mod quick;
#[path = "../src/crypto/seal.rs"]
mod seal;
// Exactly the existing real SIMD-0388 arithmetic adapter, not a success
// stub. Its `super::SysError` resolves to the production error type above.
#[path = "../src/crypto/native_tests.rs"]
mod native_sys;
mod sys {
    pub use super::native_sys::*;
    pub use permutation_frontier::crypto::sys::SysError;
}
#[path = "../src/crypto/xmd.rs"]
mod xmd;

const TEST_NAME: &str = "published_quicknet_round_32551361_opens_legacy_seal";

fn main() -> std::process::ExitCode {
    let mut filter = None;
    let mut exact = false;
    let mut list = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--exact" => exact = true,
            "--list" => list = true,
            "--test-threads=1" => {}
            "--test-threads" if args.next().as_deref() == Some("1") => {}
            value if !value.starts_with('-') && filter.is_none() => filter = Some(arg),
            _ => {
                eprintln!("unsupported argument; use one filter, --exact, --list or --test-threads=1");
                return std::process::ExitCode::from(2);
            }
        }
    }
    let selected = filter.as_deref().is_none_or(|value| {
        if exact {
            TEST_NAME == value
        } else {
            TEST_NAME.contains(value)
        }
    });
    if list {
        if selected {
            println!("{TEST_NAME}: test");
        }
    } else if selected {
        published_quicknet_round_32551361_opens_legacy_seal();
        println!("test {TEST_NAME} ... ok (1 passed)");
    } else {
        println!("0 tests run; 1 filtered out");
    }
    std::process::ExitCode::SUCCESS
}

fn published_quicknet_round_32551361_opens_legacy_seal() {
    use frontier_abi::log::seal_code;
    use permutation_rules::frontier::seal as kseal;
    use quick::tests::{decode, FIXTURE_HINTS_HEX, FIXTURE_ROUND, FIXTURE_SIG_HEX};
    use seal::tests::{cases, get};

    // Pin the complete committed input, including the original ciphertext.
    // Never invoke its generator or use its recorded k/sigma as an opener.
    let vectors = include_bytes!("../../permutation-rules/vectors/seal-vectors-v1.json");
    assert_eq!(
        xmd::sha256(&[vectors]),
        decode::<32>("9b93a9fb89e4c254942a78037210228ec91642f311b55cfefa076e5b9e294887")
    );
    let all = cases();
    let matching: Vec<_> = all
        .iter()
        .filter(|c| get(c, "name") == "valid_spv2_32551361")
        .collect();
    assert_eq!(matching.len(), 1, "one immutable published case");
    let case = matching[0];
    assert_eq!(get(case, "expect"), "valid");
    assert_eq!(get(case, "round").parse::<u64>().unwrap(), FIXTURE_ROUND);
    assert!(
        get(case, "open_sig") == FIXTURE_SIG_HEX,
        "published opening signature"
    );
    assert!(
        get(case, "sig") == FIXTURE_SIG_HEX,
        "published round signature"
    );
    assert!(quick::PK == quick::QUICKNET_PK, "production quicknet key");

    let ciphertext = decode::<{ seal::SEAL_LEN }>(get(case, "seal"));
    let commitment = decode::<32>(get(case, "commit"));
    let expected_plain = decode::<{ kseal::PLAIN_LEN }>(get(case, "plain"));
    let host_id = get(case, "host_id").parse::<u64>().unwrap();
    let arrive_bell = get(case, "arrive_bell").parse::<u32>().unwrap();
    let signature = decode::<48>(FIXTURE_SIG_HEX);
    let hints = decode::<{ 2 * quick::HINT_LEN }>(FIXTURE_HINTS_HEX);

    let verified_signature = quick::verify(FIXTURE_ROUND, &signature, &hints)
        .expect("the published signature must verify against the production key");
    let opened = seal::open(&verified_signature, &ciphertext, &commitment)
        .expect("real pairing, key recovery and FO check must open the published seal");
    assert!(opened == expected_plain, "published plaintext");
    let (code, judged_plain) = seal::judge(
        &verified_signature,
        &ciphertext,
        &commitment,
        host_id,
        arrive_bell,
    );
    assert_eq!(code, seal_code::VALID);
    assert!(
        judged_plain == Some(kseal::unpack(&expected_plain)),
        "valid published march"
    );

    // Independently bind the recovered key to the published salt and
    // commitment. Neither recovered nor recorded key material is printed,
    // exported, asserted with Debug, or substituted for recovery.
    let ibe: &[u8; seal::IBE_LEN] = ciphertext[..seal::IBE_LEN].try_into().unwrap();
    let recovered_key = seal::recover_key(&verified_signature, ibe)
        .expect("the unchanged IBE block must recover its symmetric opening key");
    let salt = kseal::salt_of(&recovered_key);
    assert_eq!(salt, decode::<32>(get(case, "salt")));
    assert_eq!(kseal::commit(&opened, &salt), commitment);
    assert_eq!(kseal::ct_hash(&ciphertext), decode::<32>(get(case, "ct_hash")));
    assert_eq!(
        seal::seal_root_of(&commitment, &ciphertext),
        decode::<32>(get(case, "seal_root"))
    );
}
