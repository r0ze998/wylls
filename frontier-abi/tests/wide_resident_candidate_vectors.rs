#![cfg(feature = "world-index-experimental")]
//! Golden vectors of the wide band's player commands and their WideResidentAct (0xDD) wrapping, as the LOCAL TEST
//! CANDIDATE lane `localnet-conquest-nft-sbf` would carry them for an NFT Citizen (not an allocation). The same bytes
//! are in `vectors/v2/wide-resident-candidate.json`, which the page's JS encoders are checked against
//! (permutation-gateway/test/frontier-wide-commands.test.mjs): this file checks the Rust encoders and decoders give and
//! take exactly those bytes, so the two sides cannot drift.
//! WRITTEN 2026-11-14 WITHOUT COMPILING (no host build was agreed then). Run when a build slot is agreed:
//!   cargo test -p frontier-abi --features world-index-experimental --test wide_resident_candidate_vectors
//! Key-free: literal bytes only.

use frontier_abi::world_index::economy::Action;
use frontier_abi::world_index::wide_ix::{
    ClaimSite, DeclareSiege, Dissolve, Economy, Garrison, Muster, ResidentAct,
};

const VECTORS: &str = include_str!("../vectors/v2/wide-resident-candidate.json");

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// The bytes are the file's (both sides read the same expectation).
fn expect(bytes: &[u8], want: &str) {
    assert_eq!(hex(bytes), want);
    assert!(
        VECTORS.contains(&format!("\"hex\": \"{want}\"")),
        "{want} is in the vectors file"
    );
}

#[test]
fn claim_site() {
    let c = ClaimSite {
        p: -3,
        q: 5,
        site: 2,
        slot: 2,
    };
    expect(&c.to_bytes(), "d9fdffffffffffffff05000000000000000202");
    assert_eq!(ClaimSite::decode(&c.to_bytes()).unwrap(), c);
}

#[test]
fn muster() {
    let m = Muster {
        unit: 0,
        troops: 100,
        tile: 17,
    };
    expect(&m.to_bytes(), "daff0101006400000011");
    assert_eq!(Muster::decode(&m.to_bytes()).unwrap(), m);
}

#[test]
fn dissolve() {
    let mut host = [0u8; 56];
    for (i, b) in host.iter_mut().enumerate() {
        *b = i as u8;
    }
    let d = Dissolve { host };
    expect(&d.to_bytes(), "daff0102000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334353637");
    assert_eq!(Dissolve::decode(&d.to_bytes()).unwrap(), d);
}

#[test]
fn economy() {
    for (action, want) in [
        (Action::Harvest, "daff0103000000000000"),
        (Action::Build { item: 0 }, "daff0103010000000000"),
        (Action::Build { item: 6 }, "daff0103010600000000"),
        (Action::Train { unit: 3, n: 500 }, "daff01030203f4010000"),
    ] {
        let e = Economy { action };
        let b = e.to_bytes().unwrap();
        expect(&b, want);
        assert_eq!(Economy::decode(&b).unwrap(), e);
    }
    assert!(Action::Build { item: 6 }.mirror_write());
    assert!(Action::Build { item: 7 }.mirror_write());
    assert!(!Action::Build { item: 0 }.mirror_write());
    // no wire form out of range (the vectors file's "refused")
    assert!(Action::Build { item: 9 }.to_bytes().is_none());
    assert!(Action::Train { unit: 7, n: 1 }.to_bytes().is_none());
    assert!(Action::Train { unit: 0, n: 0 }.to_bytes().is_none());
}

#[test]
fn garrison() {
    let g = Garrison { delta: 250 };
    expect(&g.to_bytes().unwrap(), "daff0104fa00000000000000");
    assert!(Garrison { delta: 0 }.to_bytes().is_none());
    assert!(Garrison {
        delta: 4_294_967_296
    }
    .to_bytes()
    .is_none());
}

#[test]
fn declare_siege() {
    expect(
        &DeclareSiege { site: 4, entry: 1 }.to_bytes(),
        "daff01050401",
    );
}

#[test]
fn resident_act_wrapping() {
    for (generation, inner, want) in [
        (
            1u32,
            "daff0101006400000011",
            "dd01000000daff0101006400000011",
        ),
        (
            258u32,
            "daff0103000000000000",
            "dd02010000daff0103000000000000",
        ),
    ] {
        let inner = unhex(inner);
        let mut out = [0u8; 64];
        let n = ResidentAct {
            generation,
            inner: &inner,
        }
        .encode_into(&mut out)
        .unwrap();
        expect(&out[..n], want);
        let back = ResidentAct::decode(&out[..n]).unwrap();
        assert_eq!(back.generation, generation);
        assert_eq!(back.inner, &inner[..]);
    }
    // a v2 tag, or the act itself, is never inside
    assert!(ResidentAct::decode(&unhex("dd0100000000")).is_err());
    assert!(ResidentAct::decode(&unhex("dd01000000dd01000000daff0101006400000011")).is_err());
}
