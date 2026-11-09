//! Synthetic 264-byte wide-seal integration proof over an immutable public
//! IBE block. The fixed wide body is constructed in memory only, using the
//! symmetric key recovered from that block and its verified public signature.
//! This is NOT historical wide transaction evidence or a settlement proof.
//! Reusing this published symmetric key/keystream is UNSAFE for production
//! sealing and provides no confidentiality or new timelock. No fixture is exported.
//!
//! `harness = false` retains the original `cfg(test)` fixture readers without
//! collecting or running their unrelated tests. Default runs one proof;
//! one name filter, `--exact`, `--list` and `--test-threads=1` are supported.
//! Unsupported arguments fail before the proof; listing never executes it.

#![cfg(not(target_os = "solana"))]

#[cfg(any(
    feature = "native-crypto-tests",
    feature = "test-beacon",
    feature = "oracle"
))]
compile_error!("public_wide_seal_verification requires ordinary production quicknet features");

extern crate alloc;

use permutation_frontier::crypto::sys::SysError;
pub use permutation_frontier::{error, heap, markers, Error};

#[path = "../src/crypto/field.rs"]
mod field;
#[path = "../src/crypto/quick.rs"]
mod quick;
#[path = "../src/crypto/seal.rs"]
mod seal;
// Unchanged real SIMD-0388 arithmetic. The linked program library's host
// syscalls and gameplay gates remain fail-closed; this adapter is local.
#[path = "../src/crypto/native_tests.rs"]
mod native_sys;
mod sys {
    pub use super::native_sys::*;
    pub use permutation_frontier::crypto::sys::SysError;
}
#[path = "../src/crypto/xmd.rs"]
mod xmd;

const TEST_NAME: &str = "synthetic_wide_body_opens_with_published_ibe";

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
        synthetic_wide_body_opens_with_published_ibe();
        println!("test {TEST_NAME} ... ok (1 passed)");
    } else {
        println!("0 tests run; 1 filtered out");
    }
    std::process::ExitCode::SUCCESS
}

fn synthetic_wide_body_opens_with_published_ibe() {
    use frontier_abi::log::seal_code;
    use frontier_abi::world_index::{seal as wseal, ProvinceKey, WideCoord, WideHostRef, WorldId};
    use permutation_rules::frontier::seal as kseal;
    use quick::tests::{decode, FIXTURE_HINTS_HEX, FIXTURE_ROUND, FIXTURE_SIG_HEX};
    use seal::tests::{cases, get};

    let vectors = include_bytes!("../../permutation-rules/vectors/seal-vectors-v1.json");
    assert_eq!(
        xmd::sha256(&[vectors]),
        decode::<32>("9b93a9fb89e4c254942a78037210228ec91642f311b55cfefa076e5b9e294887")
    );
    let case = cases()
        .into_iter()
        .find(|c| get(c, "name") == "valid_spv2_32551361")
        .expect("the immutable published case exists");
    assert_eq!(get(&case, "round").parse::<u64>().unwrap(), FIXTURE_ROUND);
    assert!(
        get(&case, "open_sig") == FIXTURE_SIG_HEX,
        "published signature"
    );
    assert!(quick::PK == quick::QUICKNET_PK, "production quicknet key");
    let legacy = decode::<{ seal::SEAL_LEN }>(get(&case, "seal"));
    let ibe: [u8; seal::IBE_LEN] = legacy[..seal::IBE_LEN].try_into().unwrap();
    let signature = decode::<48>(FIXTURE_SIG_HEX);
    let hints = decode::<{ 2 * quick::HINT_LEN }>(FIXTURE_HINTS_HEX);
    let verified = quick::verify(FIXTURE_ROUND, &signature, &hints)
        .expect("verify the published signature against the production key");
    let recovered_key = seal::recover_key(&verified, &ibe)
        .expect("recover the existing symmetric key through real pairing and FO");
    // No recorded k/sigma is read, and no key is printed or Debug-asserted.
    let salt = kseal::salt_of(&recovered_key);
    assert_eq!(salt, decode::<32>(get(&case, "salt")));

    let world = WorldId::new([0x77; 32]).unwrap();
    let province_key = |p| ProvinceKey::new(world, WideCoord::checked(p, 0).unwrap());
    let host = WideHostRef::new(province_key(40_000), 3, 1, 7).unwrap();
    let arrive = get(&case, "arrive_bell").parse::<u32>().unwrap();
    let (path_len, path) = kseal::encode_path(&[0]).unwrap();
    let plain = wseal::WidePlain {
        version: wseal::WIDE_PLAIN_VERSION,
        host,
        arrive_bell: arrive,
        dest: province_key(40_001),
        dest_tile: 60,
        stance: 2,
        retreat_bps: 0,
        path_len,
        path,
        reserved: [0; wseal::WIDE_RESERVED_BYTES],
    };
    // These fixed identities exceed legacy i16 coordinates. This checks
    // committed fields, not whether a real host can travel this route.
    let packed = wseal::pack(&plain);
    assert_eq!(packed.len(), 136);
    assert_eq!(wseal::validate(&plain, &host, arrive), Ok(()));
    let body = wseal::body_xor(&recovered_key, &packed);
    let synthetic = wseal::assemble(&ibe, &body);
    assert_eq!(synthetic.len(), 264);
    assert!(
        wseal::ibe_block(&synthetic) == ibe,
        "unchanged published IBE block"
    );
    let commitment = wseal::commit(&packed, &salt);
    assert_eq!(
        commitment,
        xmd::sha256(&[b"PS-FRONTIER-MARCH-WIDE-v1", &packed, &salt])
    );
    // This exact structural root is computed from the synthetic bytes,
    // not claimed to be a published golden vector or a logged chain root.
    let expected_root = xmd::sha256(&[&commitment, &xmd::sha256(&[&synthetic])]);
    assert_eq!(seal::wide_seal_root_of(&commitment, &synthetic), expected_root);

    let opened = seal::open_wide(&verified, &synthetic, &commitment)
        .expect("open_wide must repeat real IBE recovery and open all 136 bytes");
    assert!(opened == packed, "exact synthetic wide plaintext");
    let (code, judged) = seal::judge_wide(&verified, &synthetic, &commitment, &host, arrive);
    assert_eq!(code, seal_code::VALID);
    assert!(
        judged == Some(plain),
        "exact full wide identity and destination"
    );

    let legacy_commitment = decode::<32>(get(&case, "commit"));
    assert!(
        seal::open_wide(&verified, &synthetic, &legacy_commitment)
            == Err(seal_code::COMMIT_MISMATCH),
        "the published legacy commitment must refuse the synthetic wide body"
    );
    let wrong_host = WideHostRef::new(province_key(40_000), 3, 1, 8).unwrap();
    assert!(
        seal::judge_wide(&verified, &synthetic, &commitment, &wrong_host, arrive)
            == (seal_code::BAD_PLAINTEXT, None),
        "a different expected host must be refused"
    );
    assert!(
        seal::judge_wide(&verified, &synthetic, &commitment, &host, arrive + 1)
            == (seal_code::BAD_PLAINTEXT, None),
        "a different expected arrival bell must be refused"
    );
}
